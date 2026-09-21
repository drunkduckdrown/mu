import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const bin = join(root, "kyrn/bin");
/** Starting pi needs the repository's dependencies; a bare git worktree has none. */
const installed = existsSync(join(root, "node_modules/.bin/tsx"));
const nodeDir = dirname(process.execPath);

const homes: string[] = [];
function home(): string {
	const dir = mkdtempSync(join(tmpdir(), "mu-launcher-"));
	homes.push(dir);
	return dir;
}
afterEach(() => {
	while (homes.length > 0) rmSync(homes.pop() as string, { recursive: true, force: true });
});

function run(command: string, args: string[], env: Record<string, string>) {
	const result = spawnSync(join(bin, command), args, {
		encoding: "utf8",
		input: "",
		// Nothing of the developer's own setup leaks in: no real home, no MU_* or KYRN_* variables.
		env: { PATH: `${nodeDir}:/usr/bin:/bin`, ...env },
		timeout: 60_000,
	});
	return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

describe("the mu launcher", () => {
	it("answers to the old command name too", () => {
		const dir = home();
		expect(run("mu", ["help"], { HOME: dir }).out).toContain("mu link | unlink");
		expect(run("kyrn", ["help"], { HOME: dir }).out).toContain("mu link | unlink");
		expect(run("kyrn-dev", ["help"], { HOME: dir }).out).toContain("mu link | unlink");
	});

	it("links itself as `mu`, and leaves another program of that name alone", () => {
		const dir = home();
		const links = join(dir, "bin");
		const other = join(dir, "other");
		mkdirSync(other);
		writeFileSync(join(other, "mu"), "#!/bin/sh\necho maildir-utils\n");
		chmodSync(join(other, "mu"), 0o755);

		const shadowing = run("mu", ["link"], {
			HOME: dir,
			MU_LINK_DIR: links,
			PATH: `${other}:${nodeDir}:/usr/bin:/bin`,
		});
		expect(shadowing.code).toBe(1);
		expect(shadowing.out).toContain("Another mu is already on your PATH");
		expect(existsSync(join(links, "mu"))).toBe(false);

		expect(run("mu", ["link"], { HOME: dir, MU_LINK_DIR: links }).code).toBe(0);
		expect(readlinkSync(join(links, "mu"))).toBe(join(bin, "mu"));
		// Linking again over its own link is fine; a file that is not a link to it is not replaced.
		expect(
			run("mu", ["link"], { HOME: dir, MU_LINK_DIR: links, PATH: `${links}:${nodeDir}:/usr/bin:/bin` }).code,
		).toBe(0);
		rmSync(join(links, "mu"));
		writeFileSync(join(links, "mu"), "someone else's file");
		expect(run("mu", ["link"], { HOME: dir, MU_LINK_DIR: links }).code).toBe(1);
		expect(readFileSync(join(links, "mu"), "utf8")).toBe("someone else's file");
	});

	it.skipIf(!installed)("rebuilds an app view that still carries the old name, keeping pi's package name", () => {
		const dir = home();
		const app = join(dir, ".mu/app");
		mkdirSync(app, { recursive: true });
		const stale = { name: "@earendil-works/pi-coding-agent", piConfig: { name: "kyrn", configDir: ".kyrn" } };
		writeFileSync(join(app, "package.json"), JSON.stringify(stale));
		// Newer than upstream's package.json, so the age check alone would keep it.
		utimesSync(join(app, "package.json"), new Date("2030-01-01"), new Date("2030-01-01"));

		const version = run("mu", ["--version"], { HOME: dir });

		expect(version.code).toBe(0);
		const rebuilt = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
		expect(rebuilt.piConfig).toEqual({ name: "mu", configDir: ".mu" });
		expect(rebuilt.name).toBe("@earendil-works/pi-coding-agent");
		expect(existsSync(join(dir, ".mu/agent"))).toBe(true);
	});

	it.skipIf(!installed)("stays in ~/.kyrn on a machine whose home has not been moved, without creating ~/.mu", () => {
		const dir = home();
		mkdirSync(join(dir, ".kyrn/agent"), { recursive: true });

		expect(run("mu", ["--version"], { HOME: dir }).code).toBe(0);

		expect(existsSync(join(dir, ".mu"))).toBe(false);
		expect(JSON.parse(readFileSync(join(dir, ".kyrn/app/package.json"), "utf8")).piConfig.name).toBe("mu");
	});
});

describe("mu migrate", () => {
	/** A home from before the rename. The login file is a stand-in: only its bytes and its mode matter here. */
	function oldHome(): string {
		const dir = home();
		mkdirSync(join(dir, ".kyrn/agent"), { recursive: true });
		mkdirSync(join(dir, ".kyrn/acp-sessions"));
		mkdirSync(join(dir, ".kyrn/local-judge"));
		writeFileSync(join(dir, ".kyrn/agent/kyrn.json"), JSON.stringify({ tiers: ["old"] }));
		writeFileSync(join(dir, ".kyrn/agent/auth.json"), "stand-in-login", { mode: 0o600 });
		writeFileSync(
			join(dir, ".kyrn/acp-sessions/a.json"),
			JSON.stringify({ file: join(dir, ".kyrn/agent/sessions/x") }),
		);
		return dir;
	}
	/** `pgrep` as the launcher sees it: the machine running the tests may well have a real session open. */
	function processes(dir: string, running: string): Record<string, string> {
		const stubs = join(dir, "stubs");
		mkdirSync(stubs);
		const script = `#!/bin/sh\ncase "$*" in *"${running}"*) echo 4242; exit 0;; esac\nexit 1\n`;
		writeFileSync(join(stubs, "pgrep"), script, { mode: 0o755 });
		return { HOME: dir, PATH: `${stubs}:${nodeDir}:/usr/bin:/bin` };
	}
	const isLink = (path: string) => lstatSync(path).isSymbolicLink();

	it("moves the home in one step, leaves the login file as it was, and links the old path to the new", () => {
		const dir = oldHome();
		// A judge that is no longer running left its pid behind: that must not hold anything up.
		writeFileSync(join(dir, ".kyrn/local-judge/judge.pid"), "99999999");

		const moved = run("mu", ["migrate"], processes(dir, "nothing-is-running"));

		expect(moved.code).toBe(0);
		expect(isLink(join(dir, ".mu"))).toBe(false);
		expect(isLink(join(dir, ".kyrn"))).toBe(true);
		expect(readlinkSync(join(dir, ".kyrn"))).toBe(join(dir, ".mu"));
		expect(JSON.parse(readFileSync(join(dir, ".mu/agent/mu.json"), "utf8"))).toEqual({ tiers: ["old"] });
		expect(existsSync(join(dir, ".mu/agent/kyrn.json"))).toBe(false);
		expect(readFileSync(join(dir, ".mu/agent/auth.json"), "utf8")).toBe("stand-in-login");
		expect(statSync(join(dir, ".mu/agent/auth.json")).mode & 0o777).toBe(0o600);
		expect(moved.out).not.toContain("stand-in-login");
		// The desktop's session mappings store absolute paths into the old home.
		expect(existsSync(join(dir, ".kyrn/acp-sessions/a.json"))).toBe(true);

		const again = run("mu", ["migrate"], processes(join(dir, ".mu"), "nothing-is-running"));
		expect(again.code).toBe(0);
		expect(again.out).toContain("Nothing to move");
		expect(run("mu", ["migrate"], { HOME: dir }).out).toContain("Already moved");
	});

	it("only says what it would do with --dry-run", () => {
		const dir = oldHome();

		const dry = run("mu", ["migrate", "--dry-run"], processes(dir, "nothing-is-running"));

		expect(dry.code).toBe(0);
		expect(dry.out).toContain("Nothing was changed");
		expect(isLink(join(dir, ".kyrn"))).toBe(false);
		expect(existsSync(join(dir, ".mu"))).toBe(false);
		expect(existsSync(join(dir, ".kyrn/agent/kyrn.json"))).toBe(true);
	});

	it("never merges into or overwrites a ~/.mu that is already there", () => {
		const dir = oldHome();
		mkdirSync(join(dir, ".mu/agent"), { recursive: true });
		writeFileSync(join(dir, ".mu/agent/mu.json"), JSON.stringify({ tiers: ["new"] }));

		const refused = run("mu", ["migrate"], processes(dir, "nothing-is-running"));

		expect(refused.code).toBe(1);
		expect(refused.out).toContain("already exists");
		expect(isLink(join(dir, ".kyrn"))).toBe(false);
		expect(JSON.parse(readFileSync(join(dir, ".kyrn/agent/kyrn.json"), "utf8"))).toEqual({ tiers: ["old"] });
		expect(JSON.parse(readFileSync(join(dir, ".mu/agent/mu.json"), "utf8"))).toEqual({ tiers: ["new"] });
	});

	it.each([
		["the local judge", "mu judge stop", "nothing-is-running", true],
		["a session", "mu sessions", "kyrn-judge.ts", false],
		["the browser", "mu browser", "browser-profile", false],
		["the desktop app", "desktop app", "aioncore", false],
	])("moves nothing while %s is still running", (_what, names, running, judge) => {
		const dir = oldHome();
		// This test's own process stands in for a judge that is alive.
		if (judge) writeFileSync(join(dir, ".kyrn/local-judge/judge.pid"), String(process.pid));

		const refused = run("mu", ["migrate"], processes(dir, running));

		expect(refused.code).toBe(1);
		expect(refused.out).toContain("Nothing was moved");
		expect(refused.out).toContain(names);
		expect(isLink(join(dir, ".kyrn"))).toBe(false);
		expect(existsSync(join(dir, ".mu"))).toBe(false);
	});
});
