import { toolRisk } from "../../decisions/tool-risk.ts";
import { clip, failOpen, type KyrnRuntime } from "../runtime.ts";

const RULES: readonly (readonly [RegExp, string])[] = [
	[/\brm\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*[rf]/, "recursive or forced delete"],
	[
		/\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--\s|branch\s+-D|stash\s+(drop|clear))/,
		"discards git work",
	],
	[/\bgit\s+push\b.*(--force|\s-f\b)/, "force push"],
	[/\b(drop|truncate)\s+(table|database|schema)\b/i, "drops database objects"],
	[/\bmkfs\b|\bdd\b.*\bof=\/dev\//, "overwrites a device"],
	[/\bchmod\s+-R\s+0?777\b/, "opens permissions recursively"],
	[/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z)?sh\b/, "runs a downloaded script"],
	[/\bsudo\b/, "runs as root"],
];

/** Why a shell command deserves a second look, or undefined when no rule matches. */
export function riskFlag(command: string): string | undefined {
	return RULES.find(([pattern]) => pattern.test(command))?.[1];
}

/**
 * B3: rules pick the commands, the judge says whether the user asked for it,
 * and only an unvouched-for command reaches the user as a confirmation. The
 * judge can add a gate, never open one: no verdict means the user is asked.
 */
export function registerGuard(runtime: KyrnRuntime): void {
	const options = runtime.options("guard", { enabled: true });
	if (!options.enabled) return;

	runtime.pi.on(
		"tool_call",
		failOpen(async (event, ctx) => {
			runtime.touch(ctx);
			if (event.toolName !== "bash") return undefined;
			const command = String((event.input as { command?: unknown }).command ?? "");
			const flag = riskFlag(command);
			if (!flag) return undefined;

			const decision = await runtime.engine.decide(
				toolRisk,
				{ command: clip(command, 400), userMessage: clip(runtime.turn.userMessage, 400), flag },
				{ signal: ctx.signal },
			);
			// Off and shadow leave pi's own behavior alone; only an active gate may stop a command.
			if (decision.mode !== "active" || decision.outcome === "allow") return undefined;
			if (!ctx.hasUI)
				return { block: true, reason: `mu: "${flag}" needs confirmation, which this mode cannot ask for.` };
			const approved = await ctx.ui.confirm(`mu: ${flag}`, `Run this command?\n\n${clip(command, 600)}`);
			return approved ? undefined : { block: true, reason: `The user declined this command (${flag}).` };
		}),
	);
}
