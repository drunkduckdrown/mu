/**
 * The one test that talks to a real language server. Opt-in, because it needs
 * `typescript-language-server` (and a TypeScript it can load) on this machine
 * and takes seconds:
 *
 *   MU_LSP_REAL=1 vitest --run test/lsp-real-server.test.ts
 *
 * Nothing is installed for it. Without the server on PATH it is skipped.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LspClient } from "../src/lsp/client.ts";
import { isExecutableFile } from "../src/lsp/manager.ts";
import { findOnPath, languageIdFor, spawnPlan } from "../src/lsp/servers.ts";
import { uriStyleFor } from "../src/lsp/uri.ts";

const executable = findOnPath("typescript-language-server", {
	env: process.env,
	platform: process.platform,
	isExecutable: (path) => isExecutableFile(path),
});

describe.skipIf(!executable || process.env.MU_LSP_REAL !== "1")("typescript-language-server", () => {
	let client: LspClient | undefined;
	let root: string | undefined;
	afterEach(async () => {
		await client?.stop();
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("reports the type error an edit introduced, and not the one that was there before", async () => {
		root = mkdtempSync(join(tmpdir(), "mu-lsp-real-"));
		writeFileSync(
			join(root, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }),
		);
		const file = join(root, "a.ts");
		const before = 'export const old: number = "already wrong";\nexport const fine = 1;\n';
		const after = `// a new first line\n${before}export const added: string = 42;\n`;
		writeFileSync(file, before);

		const plan = spawnPlan(executable as string, ["--stdio"], process.platform, process.env);
		client = new LspClient({
			...plan,
			root,
			uriStyle: uriStyleFor({ platform: process.platform, env: process.env, executable }),
			languageId: languageIdFor,
			baselineMs: 30000,
		});
		await client.start();
		client.setText(file, before, true);
		writeFileSync(file, after);
		client.setText(file, after);

		expect(await client.waitSettled(60000)).toBe(true);
		const fresh = client.fresh();
		expect(fresh).toHaveLength(1);
		expect(fresh[0].diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.line])).toEqual([["2322", 3]]);
	}, 90000);
});
