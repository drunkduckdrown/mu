// Types for the parts of build.mjs the tests call.
export function virtualModuleNames(source: string): string[];
export function rewriteMetaUrl(source: string, relativePath: string): string;
export function exactVersion(range: string): string;
export function forbiddenFiles(files: readonly string[]): string[];
export function main(argv?: readonly string[]): Promise<number>;
