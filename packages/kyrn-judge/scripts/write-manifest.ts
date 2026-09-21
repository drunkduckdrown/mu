/** Writes `manifest.json` from `src/manifest.ts`. Run with Node 24: `node packages/kyrn-judge/scripts/write-manifest.ts`. */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST } from "../src/manifest.ts";

const target = join(dirname(fileURLToPath(import.meta.url)), "../manifest.json");
writeFileSync(target, `${JSON.stringify(MANIFEST, null, "\t")}\n`);
console.log(`wrote ${target}`);
