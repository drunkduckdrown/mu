/**
 * Which tool calls can change files. The first one in a user turn is what a checkpoint is taken
 * before, so a turn that only reads costs nothing.
 *
 * Wrong in the safe direction only: an unknown tool or command counts as changing files (one snapshot
 * more than needed), and a command counts as read-only only when every part of it is on a short list.
 */
import { isShellTool } from "../extension/shell-tools.ts";

const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"find_skill",
	"find_capability",
	"locate",
	"todo",
	"browse",
	"web_fetch",
	"web_search",
	"bg_output",
]);

/** Redirection, chaining, substitution, a second line: anything that lets a command do more than it says first. */
const SHELL_TRICKS = /[<>;&`\n\r]|\$\(|\$\{/;
const READ_ONLY_PROGRAM =
	/^(?:ls|pwd|cat|head|tail|wc|which|file|stat|du|df|date|whoami|uname|echo|printf|rg|grep|sort|uniq|cut|nl|tree|git\s+(?:status|log|diff|show|blame|rev-parse|ls-files|describe)|Get-ChildItem|gci|dir|Get-Content|gc|type|Get-Location|Select-String|sls|Get-Item|gi|Get-Date|Write-Output|Write-Host)(?:\s|$)/i;

/** True for a pipeline of plain read-only programs, e.g. `git status`, `cat a.txt | grep x | head -5`. */
export function isReadOnlyCommand(command: string): boolean {
	const text = command.trim();
	if (!text || SHELL_TRICKS.test(text) || /--output\b/.test(text)) return false;
	return text.split("|").every((part) => READ_ONLY_PROGRAM.test(part.trim()));
}

export function isMutatingCall(toolName: string, input: Readonly<Record<string, unknown>>): boolean {
	if (READ_ONLY_TOOLS.has(toolName)) return false;
	if (isShellTool(toolName)) return !isReadOnlyCommand(String(input.command ?? ""));
	return true;
}

const CHECK_COMMAND =
	/\b(?:vitest|jest|pytest|mocha|ava|tsc|eslint|biome|ruff|mypy|rspec|phpunit|ctest|tox|nox|gradle|mvn)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|check|lint|typecheck)\b|\b(?:cargo|go|dotnet|swift|make|deno)\s+(?:test|build|check|vet|clippy)\b|\bnode\b[^\n]*--test\b|\btest\.sh\b/;

/** A command whose exit code says whether the work holds up: a test run, a build, a type check, a linter. */
export function isCheckCommand(command: string): boolean {
	return CHECK_COMMAND.test(command);
}
