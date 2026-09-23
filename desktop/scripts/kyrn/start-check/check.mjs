#!/usr/bin/env node
// Checks, on this machine, the chain the desktop app uses to start mu, as the app and AionCore run it:
//
//   1. the harness is found (MU_ROOT / KYRN_ROOT, a checkout beside the desktop, or mu-agent from npm);
//   2. PiRpc starts it as the adapter does (on Windows `node kyrn/bin/mu.mjs --mode rpc`, no shell), it answers
//      get_commands, and closing it ends its whole process tree;
//   3. the registration's command (scripts/kyrn/acp; on Windows acp.cmd through `cmd /d /c`, as AionCore wraps it)
//      answers the ACP handshake and opens a session, which starts mu under the adapter, and ending the command's
//      tree as AionCore does leaves nothing behind;
//   4. with --packaged, step 3 for the packaged app: the adapter bundled by scripts/build-mcp-servers.js and
//      resources/mu/acp(.cmd), laid out as in an installed app's resources folder.
//
// Everything runs in a throwaway home (HOME and USERPROFILE): ~/.mu is never touched, no model is called, no key is
// needed. Exits 1 when a step fails.
//
//   node scripts/kyrn/start-check/check.mjs [--packaged]
//
// Needs Node 22.19 or newer (it loads the adapter's TypeScript with Node's type stripping), the harness's
// dependencies (npm ci in its checkout) and the desktop's (bun install).
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const windows = process.platform === 'win32';
const packaged = process.argv.includes('--packaged');
const home = mkdtempSync(join(tmpdir(), 'mu-start-check-'));
// Before the adapter's modules load: they read the home when called.
process.env.HOME = home;
process.env.USERPROFILE = home;

const adapterModule = (file) =>
  import(pathToFileURL(join(desktop, 'packages', 'desktop', 'src', 'process', 'agent', 'kyrn', file)).href);
const { findHarness, launcherOf } = await adapterModule('harness.ts');
const { PiRpc } = await adapterModule('piRpc.ts');

let failed = 0;
function report(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

function within(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every process of this machine as [pid, parent pid]. */
function processTable() {
  const text = windows
    ? execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
        ],
        { encoding: 'utf8', windowsHide: true }
      )
    : execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, parent]) => pid > 0 && parent >= 0);
}

/** A process and all its descendants, as they are now. */
function tree(root) {
  const children = new Map();
  for (const [pid, parent] of processTable()) children.set(parent, [...(children.get(parent) ?? []), pid]);
  const found = [root];
  for (let i = 0; i < found.length; i++) found.push(...(children.get(found[i]) ?? []));
  return found;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function gone(pids, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!pids.some(alive)) return true;
    await sleep(250);
  }
  return !pids.some(alive);
}

/** Ends a command's tree as AionCore does: taskkill /F /T on Windows, the process group elsewhere. */
function endAsAionCore(child) {
  if (windows)
    execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
  else process.kill(-child.pid, 'SIGTERM');
}

/** Starts an ACP command, shakes hands, opens a session, then ends it. */
async function acp(name, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: home,
    env: { ...process.env, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: !windows,
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-2000);
  });
  const waiting = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    waiting.get(message.id)?.(message);
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const call = (id, method, params, ms) =>
    within(
      Promise.race([
        new Promise((resolve) => {
          waiting.set(id, resolve);
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        }),
        exited.then((code) => {
          throw new Error(`exited with ${code}${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`);
        }),
      ]),
      ms,
      method
    );
  try {
    const hello = await call(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} }, 60000);
    report(`${name}: ACP handshake`, hello.result?.agentInfo?.title === 'mu', JSON.stringify(hello.result?.agentInfo));
    const started = Date.now();
    const session = await call(2, 'session/new', { cwd: home, mcpServers: [] }, 180000);
    report(
      `${name}: a session starts mu`,
      typeof session.result?.sessionId === 'string',
      session.error ? session.error.message : `${Date.now() - started} ms`
    );
  } catch (error) {
    report(`${name}`, false, error.message);
  }
  const pids = tree(child.pid);
  endAsAionCore(child);
  report(`${name}: ending it leaves nothing behind`, await gone(pids), `${pids.length} processes`);
}

try {
  // 1. The harness.
  const harness = findHarness(desktop);
  report('harness found', Boolean(harness), harness ? `${harness.source}, ${harness.layout}: ${harness.root}` : '');
  if (!harness) process.exit(1);

  // 2. mu over RPC, started as the adapter starts it.
  const launcher = launcherOf(harness, process.platform);
  const rpc = new PiRpc(launcher, home, undefined, () => {});
  const started = Date.now();
  try {
    const data = await within(rpc.send({ type: 'get_commands' }), 180000, 'get_commands');
    const names = (data.commands ?? []).map((command) => command.name);
    report('mu answers over RPC', names.includes('goal'), `${names.length} commands in ${Date.now() - started} ms`);
  } catch (error) {
    report('mu answers over RPC', false, error.message);
  }
  // The child is private to TypeScript, not at run time.
  const pids = rpc.child?.pid ? tree(rpc.child.pid) : [];
  rpc.close();
  report('closing mu ends its whole tree', await gone(pids), `${pids.length} processes`);

  // 3. The registration's command, as AionCore runs it.
  const scripts = join(desktop, 'scripts', 'kyrn');
  if (windows) await acp('scripts/kyrn/acp.cmd', 'cmd.exe', ['/d', '/c', join(scripts, 'acp.cmd')]);
  else await acp('scripts/kyrn/acp', join(scripts, 'acp'), []);

  // 4. The packaged app's launcher and bundled adapter.
  if (packaged) {
    execFileSync(process.execPath, [join(desktop, 'scripts', 'build-mcp-servers.js')], { stdio: 'inherit' });
    const resources = join(home, 'Resources');
    mkdirSync(join(resources, 'mu'), { recursive: true });
    mkdirSync(join(resources, 'app.asar.unpacked', 'out', 'main'), { recursive: true });
    copyFileSync(
      join(desktop, 'out', 'main', 'mu-acp.js'),
      join(resources, 'app.asar.unpacked', 'out', 'main', 'mu-acp.js')
    );
    for (const name of ['acp', 'acp.cmd'])
      copyFileSync(join(desktop, 'resources', 'mu', name), join(resources, 'mu', name));
    chmodSync(join(resources, 'mu', 'acp'), 0o755);
    // An installed app has no checkout beside it: the harness comes from MU_ROOT here, from npm for a user.
    const launch = join(resources, 'mu', windows ? 'acp.cmd' : 'acp');
    if (windows) await acp('packaged resources/mu/acp.cmd', 'cmd.exe', ['/d', '/c', launch], { MU_ROOT: harness.root });
    else await acp('packaged resources/mu/acp', launch, [], { MU_ROOT: harness.root });
  }
} finally {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
