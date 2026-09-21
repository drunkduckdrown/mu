import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { muEnv, muHome } from "../naming.ts";

const CANDIDATES: readonly string[] = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
];

export function findChrome(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
	const chosen = muEnv("CHROME", env);
	if (chosen && existsSync(chosen)) return chosen;
	return CANDIDATES.find((path) => existsSync(path));
}

export interface LaunchedChrome {
	/** WebSocket URL of the browser-level DevTools endpoint. */
	readonly endpoint: string;
	/** Undefined when an already running mu browser was reused. */
	readonly process?: ChildProcess;
}

function readEndpoint(profileDir: string): string | undefined {
	try {
		const [port, path] = readFileSync(join(profileDir, "DevToolsActivePort"), "utf8").trim().split("\n");
		return port && path ? `ws://127.0.0.1:${port}${path}` : undefined;
	} catch {
		return undefined;
	}
}

async function isAlive(endpoint: string): Promise<boolean> {
	const port = /:(\d+)\//.exec(endpoint)?.[1];
	if (!port) return false;
	try {
		const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) });
		return response.ok;
	} catch {
		return false;
	}
}

export interface LaunchOptions {
	readonly executable?: string;
	/** Default ~/.mu/browser-profile: mu's own profile, never the user's personal one. */
	readonly profileDir?: string;
	readonly headless?: boolean;
}

/**
 * Starts Chrome with a dedicated profile and a DevTools port, or reuses the
 * one mu already started. The user's own Chrome profile, with its cookies
 * and logged-in sessions, is never touched.
 */
export async function launchChrome(options: LaunchOptions = {}): Promise<LaunchedChrome> {
	const profileDir = options.profileDir ?? join(muHome(), "browser-profile");
	const running = readEndpoint(profileDir);
	if (running && (await isAlive(running))) return { endpoint: running };

	const executable = options.executable ?? findChrome();
	if (!executable) throw new Error("No Chrome or Chromium found. Install one or set MU_CHROME to its executable.");
	mkdirSync(profileDir, { recursive: true });
	rmSync(join(profileDir, "DevToolsActivePort"), { force: true });

	const args = [
		`--user-data-dir=${profileDir}`,
		"--remote-debugging-port=0",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-networking",
		"--window-size=1120,780",
	];
	if (options.headless !== false) args.push("--headless=new");
	const child = spawn(executable, [...args, "about:blank"], { stdio: "ignore", detached: false });

	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const endpoint = readEndpoint(profileDir);
		if (endpoint && (await isAlive(endpoint))) return { endpoint, process: child };
		if (child.exitCode !== null) throw new Error(`Chrome exited during startup (code ${child.exitCode})`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	child.kill();
	throw new Error("Chrome did not open its DevTools port in time");
}
