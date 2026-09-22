#!/usr/bin/env node
// Builds the npm package mu-agent: `npm i -g mu-agent`, then `mu`.
//
//   node kyrn/npm/build.mjs          stage the package in .artifacts/npm/mu-agent/
//   node kyrn/npm/build.mjs --pack   and write the tarball beside it (npm pack)
//
// Needs `npm run build` first: the package carries pi's own Node bundle (packages/coding-agent/dist/bundle).
// Publishing is not done here. It is `npm publish <tarball>` by whoever is logged in to npm.
//
// The package is laid out like the repository, so the launcher finds everything two folders above
// kyrn/bin/mu.mjs either way (it tells the two apart with layoutOf):
//
//   kyrn/bin/          mu.mjs (npm's `mu`), kyrn-doctor, kyrn-ledger, kyrn-judge-local
//   kyrn/local-judge/  the Laya sidecar's server (macOS). `mu judge setup` installs its venv and weights
//                      into ~/.mu/local-judge, and only when asked to
//   dist/              pi's Node bundle (dist/bundle/cli.js), with its themes, assets, export templates and
//                      the native clipboard helpers of pi-tui
//   judge/             the judgment layer built to JavaScript, with its prompts, skills and agents, and the
//                      manifest.json the desktop app reads its settings from
//   docs/, examples/   pi's documentation, which the agent reads when asked about itself
//   package.json       names the app mu (piConfig), so pi keeps its files in ~/.mu
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const codingAgent = join(repo, "packages", "coding-agent");
const judgeSource = join(repo, "packages", "kyrn-judge");

/** Optional modules their callers try and do without, as pi's own bundle allows them (scripts/build-coding-agent-bundle.mjs). */
const OPTIONAL = new Set(["bufferutil", "utf-8-validate", "kerberos", "supports-color"]);

/**
 * The module names pi hands to an extension from its own bundle (packages/coding-agent/src/core/extensions/
 * virtual-modules.ts). The judgment layer leaves exactly these to pi and carries everything else it imports:
 * esbuild's own `external` would also leave every subpath of a name, and pi has none of those to give.
 */
export function virtualModuleNames(source) {
	const body = source.slice(source.indexOf("VIRTUAL_MODULES"));
	return [...body.matchAll(/^\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*)):\s*bundled/gm)].map((match) => match[1] ?? match[2]);
}

/**
 * The judgment layer finds its prompts, skills and agents from where each source file is. One bundle is one
 * file, so every `import.meta.url` becomes the URL its source file would have: the same path, taken from the
 * judge folder, which is one level above the bundle (judge/dist/kyrn-judge.js).
 */
export function rewriteMetaUrl(source, relativePath) {
	if (!source.includes("import.meta.url")) return source;
	const path = relativePath.split(sep).join("/");
	return source.replaceAll("import.meta.url", `new URL(${JSON.stringify(path)}, new URL("../", import.meta.url)).href`);
}

/** Exact versions, as everywhere in this repository: "^0.86.0" is written 0.86.0. */
export function exactVersion(range) {
	const version = String(range).replace(/^[\^~]/, "");
	if (!/^\d+\.\d+\.\d+([-+].*)?$/.test(version)) throw new Error(`not an exact version: ${range}`);
	return version;
}

/** Nothing that could hold a credential ever goes into the package. */
export function forbiddenFiles(files) {
	return files.filter((file) => /(^|[\\/])(\.env(\..*)?|auth\.json|models-store\.json|\.npmrc|.*\.pem|.*\.key)$/.test(file) && !/\.env\.example$/.test(file));
}

function listFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...listFiles(path));
		else files.push(path);
	}
	return files;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

async function buildJudge(out) {
	const { build } = await import("esbuild");
	const provided = new Set(virtualModuleNames(readFileSync(join(codingAgent, "src/core/extensions/virtual-modules.ts"), "utf8")));
	const judgeRoot = join(out, "judge");
	const plugins = [
		{
			name: "pi-provides",
			setup(builder) {
				builder.onResolve({ filter: /^[^./]/ }, (args) => (provided.has(args.path) ? { path: args.path, external: true } : undefined));
			},
		},
		{
			name: "source-urls",
			setup(builder) {
				builder.onLoad({ filter: /\.ts$/ }, (args) => {
					if (!args.path.startsWith(join(judgeSource, "src") + sep)) return undefined;
					return {
						contents: rewriteMetaUrl(readFileSync(args.path, "utf8"), relative(judgeSource, args.path)),
						loader: "ts",
					};
				});
			},
		},
	];
	const common = {
		absWorkingDir: repo,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22.19",
		// Deep imports of pi-ai (google-login) resolve through the repository's paths to the sources.
		tsconfig: join(repo, "tsconfig.json"),
		// A CommonJS dependency inside may still call require.
		banner: {
			js: 'import { createRequire as __muCreateRequire } from "node:module"; const require = __muCreateRequire(import.meta.url);',
		},
		legalComments: "none",
		logLevel: "warning",
		metafile: true,
		plugins,
	};
	const results = [
		await build({
			...common,
			entryPoints: { "kyrn-judge": join(judgeSource, "src/extension/kyrn-judge.ts") },
			outdir: join(judgeRoot, "dist"),
		}),
		// `mu doctor` looks for a browser with the same code the browser feature uses.
		await build({ ...common, entryPoints: { chrome: join(judgeSource, "src/browser/chrome.ts") }, outdir: join(judgeRoot, "dist") }),
	];
	for (const result of results) {
		for (const output of Object.values(result.metafile.outputs)) {
			for (const imported of output.imports) {
				if (imported.external && !isBuiltin(imported.path) && !provided.has(imported.path) && !OPTIONAL.has(imported.path)) {
					throw new Error(`the judge bundle leaves ${imported.path} to be found at run time, and nothing provides it`);
				}
			}
		}
	}
	// manifest.json is what the desktop app draws its settings from, also for an mu that came from npm.
	for (const name of ["agents", "prompts", "skills", "manifest.json", "THIRD_PARTY_NOTICES.md"]) {
		cpSync(join(judgeSource, name), join(judgeRoot, name), { recursive: true });
	}
	const judgePackage = readJson(join(judgeSource, "package.json"));
	writeFileSync(
		join(judgeRoot, "package.json"),
		`${JSON.stringify({ name: judgePackage.name, version: judgePackage.version, private: true, type: "module" }, null, "\t")}\n`,
	);
	return judgePackage.version;
}

function copyPi(out) {
	const dist = join(codingAgent, "dist");
	if (!existsSync(join(dist, "bundle", "cli.js"))) {
		throw new Error("pi's bundle is missing (packages/coding-agent/dist/bundle/cli.js). Run `npm run build` first.");
	}
	cpSync(join(dist, "bundle"), join(out, "dist", "bundle"), { recursive: true });
	for (const folder of ["modes/interactive/theme", "modes/interactive/assets"]) {
		cpSync(join(dist, folder), join(out, "dist", folder), { recursive: true });
	}
	const exportHtml = join(dist, "core", "export-html");
	for (const name of ["template.html", "template.css", "template.js", "vendor"]) {
		cpSync(join(exportHtml, name), join(out, "dist", "core", "export-html", name), { recursive: true });
	}
	// pi-tui looks for its clipboard helper beside the module that loads it, one folder up. That module is
	// either the bundle's entry or one of its chunks, so the helpers go to both places.
	for (const target of ["dist", join("dist", "bundle")]) {
		for (const platform of ["darwin", "linux", "win32"]) {
			const prebuilds = join(repo, "packages", "tui", "native", platform, "prebuilds");
			if (existsSync(prebuilds)) cpSync(prebuilds, join(out, target, "native", platform, "prebuilds"), { recursive: true });
		}
	}
	cpSync(join(codingAgent, "docs"), join(out, "docs"), { recursive: true });
	cpSync(join(codingAgent, "examples"), join(out, "examples"), { recursive: true });
	return readJson(join(codingAgent, "package.json"));
}

function copyLauncher(out) {
	for (const name of ["mu.mjs", "kyrn-doctor", "kyrn-ledger", "kyrn-judge-local"]) {
		const target = join(out, "kyrn", "bin", name);
		cpSync(join(repo, "kyrn", "bin", name), target);
		chmodSync(target, 0o755);
	}
	for (const name of ["server.py", "requirements.lock.txt"]) {
		cpSync(join(repo, "kyrn", "local-judge", name), join(out, "kyrn", "local-judge", name));
	}
}

function gitCommit() {
	try {
		return execFileSync("git", ["rev-parse", "--short=9", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
	} catch {
		return undefined;
	}
}

export async function main(argv = process.argv.slice(2)) {
	const out = join(repo, ".artifacts", "npm", "mu-agent");
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
	// While working on the judgment layer's bundle: that part alone, which needs no build of pi.
	if (argv.includes("--judge-only")) {
		console.log(`Built ${relative(repo, join(out, "judge"))} (judge ${await buildJudge(out)})`);
		return 0;
	}

	const pi = copyPi(out);
	const judgeVersion = await buildJudge(out);
	copyLauncher(out);
	cpSync(join(repo, "LICENSE"), join(out, "LICENSE"));
	cpSync(join(here, "README.md"), join(out, "README.md"));
	cpSync(join(here, "CHANGELOG.md"), join(out, "CHANGELOG.md"));

	// What pi's bundle leaves to node_modules (scripts/build-coding-agent-bundle.mjs); the optional native
	// accelerators it can also use are left out, as their callers do without them.
	const bundleDependencies = ["@earendil-works/chord", "@silvia-odwyer/photon-node", "jiti"];
	const dependencies = Object.fromEntries(bundleDependencies.map((name) => [name, exactVersion(pi.dependencies[name])]));
	const template = readJson(join(here, "package.template.json"));
	const manifest = { ...template, dependencies, muBuild: { pi: pi.version, judge: judgeVersion, commit: gitCommit() } };
	writeFileSync(join(out, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);

	const files = listFiles(out).map((file) => relative(out, file));
	const forbidden = forbiddenFiles(files);
	if (forbidden.length > 0) throw new Error(`refusing to package: ${forbidden.join(", ")}`);
	const bytes = listFiles(out).reduce((total, file) => total + statSync(file).size, 0);
	console.log(`Staged ${relative(repo, out)}: ${manifest.name} ${manifest.version}, ${files.length} files, ${(bytes / 1048576).toFixed(1)} MiB`);

	if (argv.includes("--pack")) {
		const packed = JSON.parse(
			execFileSync("npm", ["pack", "--json", "--pack-destination", dirname(out)], {
				cwd: out,
				encoding: "utf8",
				shell: process.platform === "win32",
			}),
		)[0];
		console.log(
			`Packed ${relative(repo, join(dirname(out), packed.filename))}: ${packed.entryCount} files, ${(packed.size / 1048576).toFixed(1)} MiB packed, ${(packed.unpackedSize / 1048576).toFixed(1)} MiB unpacked`,
		);
	}
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().then(
		(code) => process.exit(code),
		(error) => {
			console.error(`build: ${error instanceof Error ? error.message : String(error)}`);
			process.exit(1);
		},
	);
}
