import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { muEnv } from './naming.ts';

/**
 * Where the mu harness is, and how to start it. The same rules as the harness's own launcher
 * (`kyrn/bin/mu.mjs` in the MU repository):
 *
 * - repo: a checkout, which runs the TypeScript sources. On macOS, Linux and WSL it is started through its bash
 *   forwarder, which also picks a Node >= 22.19 (a Mac app's PATH is short, and often starts with an old one).
 * - package: the npm package `mu-agent` (`npm i -g mu-agent`), laid out like a checkout but carrying pi's bundle
 *   and the judgment layer as JavaScript. It keeps its keys in mu's home, never beside the package, which npm
 *   replaces on every update.
 *
 * Windows has no bash: there both are started as `node <root>/kyrn/bin/mu.mjs`.
 */
export type HarnessLayout = 'repo' | 'package';

/** env: `MU_ROOT` / `KYRN_ROOT`. beside: a checkout next to the desktop's. global: an npm install on this machine. */
export type HarnessSource = 'env' | 'beside' | 'global';

export type Harness = { root: string; layout: HarnessLayout; source: HarnessSource };

export type HarnessDeps = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  exists: (file: string) => boolean;
  /** A directory's entries; empty when it cannot be read. */
  list: (dir: string) => string[];
  /** A path with its links resolved; the path itself when it cannot be. */
  real: (file: string) => string;
};

export const PACKAGE_NAME = 'mu-agent';

/** pi's minimum, the same as the harness launcher's. */
export const MIN_NODE: readonly [number, number] = [22, 19];

/** True when a Node version such as "24.16.0" or "v22.19.0" can run mu. */
export function nodeVersionOk(version: string): boolean {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

const defaults = (): HarnessDeps => ({
  platform: process.platform,
  env: process.env,
  home: homedir(),
  exists: existsSync,
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  real: (file) => {
    try {
      return realpathSync(file);
    } catch {
      return file;
    }
  },
});

const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix);

/** What the harness's `layoutOf` says: a checkout without its dependencies is still a checkout. */
export function layoutOf(root: string, deps: Pick<HarnessDeps, 'platform' | 'exists'>): HarnessLayout {
  const { join } = pathFor(deps.platform);
  if (deps.exists(join(root, 'packages', 'coding-agent', 'package.json'))) return 'repo';
  return deps.exists(join(root, 'dist', 'bundle', 'cli.js')) ? 'package' : 'repo';
}

/** A folder holding mu: its Node launcher is there. */
const holdsMu = (root: string, deps: Pick<HarnessDeps, 'platform' | 'exists'>): boolean =>
  deps.exists(pathFor(deps.platform).join(root, 'kyrn', 'bin', 'mu.mjs'));

const versionParts = (name: string): number[] => name.replace(/^v/, '').split('.').map(Number);

/** Newest first, by the numbers in a Node version folder name such as `v24.16.0`. */
function byVersion(a: string, b: string): number {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
  return 0;
}

/**
 * Global `node_modules` folders npm may have installed `mu-agent` into, most likely first. A GUI app's PATH is short,
 * so the usual prefixes are listed too, not only what PATH points at.
 */
export function globalModuleDirs(deps: HarnessDeps): string[] {
  const { platform, env, home } = deps;
  const p = pathFor(platform);
  const pathDirs = (env.PATH ?? env.Path ?? '').split(p.delimiter).filter(Boolean);
  const dirs: string[] = [];
  if (platform === 'win32') {
    // npm's shims (mu.cmd) sit in the prefix, beside its node_modules: %APPDATA%\npm, or nvm-windows' node folder.
    for (const dir of pathDirs) if (deps.exists(p.join(dir, 'mu.cmd'))) dirs.push(p.join(dir, 'node_modules'));
    if (env.APPDATA) dirs.push(p.join(env.APPDATA, 'npm', 'node_modules'));
    const prefix = env.npm_config_prefix || env.NPM_CONFIG_PREFIX;
    if (prefix) dirs.push(p.join(prefix, 'node_modules'));
    return [...new Set(dirs)];
  }
  const prefixes = [env.npm_config_prefix, env.NPM_CONFIG_PREFIX, p.join(home, '.npm-global')];
  // nvm: every installed Node has its own global folder.
  const nvm = p.join(env.NVM_DIR || p.join(home, '.nvm'), 'versions', 'node');
  prefixes.push(
    ...deps
      .list(nvm)
      .toSorted(byVersion)
      .map((version) => p.join(nvm, version))
  );
  prefixes.push('/opt/homebrew', '/usr/local', '/usr');
  for (const prefix of prefixes) if (prefix) dirs.push(p.join(prefix, 'lib', 'node_modules'));
  return [...new Set(dirs)];
}

/** `mu` on PATH, followed to the folder it belongs to: npm links it to `<package>/kyrn/bin/mu.mjs`. */
function muOnPath(deps: HarnessDeps): string | undefined {
  const p = pathFor(deps.platform);
  if (deps.platform === 'win32') return undefined;
  for (const dir of (deps.env.PATH ?? '').split(p.delimiter).filter(Boolean)) {
    const link = p.join(dir, 'mu');
    if (!deps.exists(link)) continue;
    const target = deps.real(link);
    const bin = p.dirname(target);
    if (p.basename(bin) === 'bin' && p.basename(p.dirname(bin)) === 'kyrn') return p.dirname(p.dirname(bin));
  }
  return undefined;
}

/**
 * The harness this app runs. `MU_ROOT` / `KYRN_ROOT` wins when set, as in development. Then a checkout beside the
 * desktop's: `../KYRN` (two repositories side by side) or `..` (the MU monorepo, where the app is `desktop/`); a
 * packaged app has no desktop checkout and skips this. Then `mu-agent` installed with npm. Undefined when there is none.
 */
export function findHarness(desktopRoot: string | undefined, patch: Partial<HarnessDeps> = {}): Harness | undefined {
  const deps = { ...defaults(), ...patch };
  const p = pathFor(deps.platform);
  const found = (root: string, source: HarnessSource): Harness => ({ root, layout: layoutOf(root, deps), source });
  const named = muEnv('ROOT', deps.env);
  if (named) return found(p.resolve(named), 'env');
  const besides = desktopRoot ? [p.join(desktopRoot, '..', 'KYRN'), p.join(desktopRoot, '..')] : [];
  for (const beside of besides) {
    const root = p.resolve(beside);
    if (holdsMu(root, deps)) return found(root, 'beside');
  }
  const linked = muOnPath(deps);
  if (linked && holdsMu(linked, deps)) return found(linked, 'global');
  for (const dir of globalModuleDirs(deps)) {
    const root = p.join(dir, PACKAGE_NAME);
    if (holdsMu(root, deps)) return found(root, 'global');
  }
  return undefined;
}

/**
 * What the adapter starts: the bash forwarder of a checkout on macOS, Linux and WSL (it picks a Node that can run
 * pi), else the Node launcher itself, which `PiRpc` runs with the adapter's own Node.
 */
export function launcherOf(harness: Pick<Harness, 'root' | 'layout'>, platform: NodeJS.Platform): string {
  const { join } = pathFor(platform);
  // The old launcher path forwards to `mu`, and exists in checkouts from before the rename too.
  if (platform !== 'win32' && harness.layout === 'repo') return join(harness.root, 'kyrn', 'bin', 'kyrn');
  return join(harness.root, 'kyrn', 'bin', 'mu.mjs');
}

/** The .env the harness reads its keys from: the checkout's, or for the npm package the one in mu's home. */
export function envFileOf(harness: Pick<Harness, 'root' | 'layout'>, home: string, platform: NodeJS.Platform): string {
  return pathFor(platform).join(harness.layout === 'package' ? home : harness.root, '.env');
}

/** The judgment layer's manifest: in a checkout beside its sources, in the package beside the built layer. */
export function manifestOf(harness: Pick<Harness, 'root' | 'layout'>, platform: NodeJS.Platform): string {
  const { join } = pathFor(platform);
  return harness.layout === 'package'
    ? join(harness.root, 'judge', 'manifest.json')
    : join(harness.root, 'packages', 'kyrn-judge', 'manifest.json');
}
