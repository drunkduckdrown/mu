import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { exactVersion, forbiddenFiles, rewriteMetaUrl, virtualModuleNames } from "../../../kyrn/npm/build.mjs";

/**
 * The npm package mu-agent (kyrn/npm/build.mjs). Building it needs pi's bundle, so these check the decisions
 * the build rests on; the package itself is built, installed and run in CI (.github/workflows/npm.yml).
 */
const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("the npm package", () => {
	it("leaves to pi exactly the modules pi hands to an extension, and no subpath of them", () => {
		const names = virtualModuleNames(
			readFileSync(join(repo, "packages/coding-agent/src/core/extensions/virtual-modules.ts"), "utf8"),
		);
		expect(names).toEqual(
			expect.arrayContaining([
				"typebox",
				"@earendil-works/pi-coding-agent",
				"@earendil-works/pi-tui",
				"@earendil-works/pi-ai",
				"@earendil-works/pi-agent-core",
			]),
		);
		// The judgment layer's deep imports of pi-ai (google-login) are not among them: those go into its bundle.
		expect(names).not.toContain("@earendil-works/pi-ai/utils/text");
		expect(names.every((name) => !name.includes(" "))).toBe(true);
	});

	it("gives every file in the one bundle the URL its source file had, taken from the judge folder", () => {
		const source = 'const PROMPTS_DIR = fileURLToPath(new URL("../../../prompts", import.meta.url));';
		const rewritten = rewriteMetaUrl(source, join("src", "extension", "features", "commands.ts"));
		expect(rewritten).toBe(
			'const PROMPTS_DIR = fileURLToPath(new URL("../../../prompts", new URL("src/extension/features/commands.ts", new URL("../", import.meta.url)).href));',
		);
		// From judge/dist/kyrn-judge.js that is judge/prompts, where the build copies them.
		const bundle = "file:///usr/lib/node_modules/mu-agent/judge/dist/kyrn-judge.js";
		const at = new URL("src/extension/features/commands.ts", new URL("../", bundle)).href;
		expect(new URL("../../../prompts", at).href).toBe("file:///usr/lib/node_modules/mu-agent/judge/prompts");
		expect(rewriteMetaUrl("export const x = 1;", "src/x.ts")).toBe("export const x = 1;");
	});

	it("never packs a file that could hold a credential", () => {
		expect(
			forbiddenFiles([
				"judge/dist/kyrn-judge.js",
				".env",
				"kyrn/.env.local",
				"kyrn/.env.example",
				"agent/auth.json",
				"x\\models-store.json",
				".npmrc",
				"certs/server.pem",
			]),
		).toEqual([".env", "kyrn/.env.local", "agent/auth.json", "x\\models-store.json", ".npmrc", "certs/server.pem"]);
	});

	it("writes dependencies as exact versions", () => {
		expect(exactVersion("^0.86.0")).toBe("0.86.0");
		expect(exactVersion("2.7.0")).toBe("2.7.0");
		expect(() => exactVersion(">=1")).toThrow("not an exact version");
	});
});
