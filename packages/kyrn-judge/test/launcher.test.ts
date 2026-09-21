import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
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
