import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MANIFEST } from "../src/manifest.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const sources = (dir: string) =>
	readdirSync(join(root, dir))
		.filter((name) => name.endsWith(".ts"))
		.map((name) => join(dir, name));

/** Decision ids as the code declares them: the `id:` right after `defineDecision({`. */
function declaredDecisions(): string[] {
	const ids = new Set<string>();
	for (const path of [...sources("src/decisions"), ...sources("src/admission")]) {
		for (const match of read(path).matchAll(/defineDecision\(\{\s*(?:\/\/[^\n]*\n\s*)*id:\s*([^,\n]+),/g)) {
			const literal = /^"([^"]+)"$/.exec(match[1].trim());
			// A computed id (the test-log wordings) is listed under its default spelling.
			ids.add(literal ? literal[1] : "tool.admission.test-log");
		}
	}
	return [...ids].sort();
}

/** Feature names as the code reads their options: `runtime.options("<name>", …`. */
function declaredFeatures(): Map<string, string> {
	const found = new Map<string, string>();
	for (const path of sources("src/extension/features")) {
		const text = read(path);
		// Options of one feature can be read in several files (the swarm's model ladder is): all of them count.
		for (const match of text.matchAll(/runtime\.options\(\s*"([a-zA-Z]+)"/g)) {
			found.set(match[1], `${found.get(match[1]) ?? ""}\n${text}`);
		}
	}
	return found;
}

describe("harness manifest", () => {
	it("lists every decision the code declares, once, under a feature that exists", () => {
		const listed = MANIFEST.decisions.map((decision) => decision.id).sort();
		expect(listed).toEqual(declaredDecisions());
		expect(new Set(listed).size).toBe(listed.length);
		const features = new Set(MANIFEST.features.map((feature) => feature.name));
		for (const decision of MANIFEST.decisions) expect(features, decision.id).toContain(decision.feature);
	});

	it("lists every feature the code reads options for, and only options that code has", () => {
		const declared = declaredFeatures();
		expect(MANIFEST.features.map((feature) => feature.name).sort()).toEqual([...declared.keys()].sort());
		for (const feature of MANIFEST.features) {
			const text = declared.get(feature.name) ?? "";
			for (const option of feature.options) {
				expect(text, `${feature.name}.${option.key}`).toMatch(new RegExp(`\\b${option.key}:`));
			}
		}
	});

	it("says everything in both languages", () => {
		const texts = [
			...Object.values(MANIFEST.groups),
			...MANIFEST.modes.flatMap((mode) => [mode.label, mode.help]),
			...MANIFEST.decisions.flatMap((decision) => [decision.title, decision.summary]),
			...MANIFEST.features.flatMap((feature) => [
				feature.title,
				feature.summary,
				...feature.options.flatMap((option) => [option.label, ...(option.help ? [option.help] : [])]),
			]),
		];
		for (const text of texts) {
			expect(text.zh.trim().length, JSON.stringify(text)).toBeGreaterThan(0);
			expect(text.en.trim().length, JSON.stringify(text)).toBeGreaterThan(0);
			expect(/[一-鿿]/.test(text.zh), text.zh).toBe(true);
		}
	});

	it("keeps manifest.json, which the desktop app reads, identical to the source", () => {
		expect(read("manifest.json")).toBe(`${JSON.stringify(MANIFEST, null, "\t")}\n`);
	});
});
