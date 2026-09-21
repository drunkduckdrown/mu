import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";
import { turnCompletion } from "../../decisions/turn-completion.ts";
import { clip, failOpen, type KyrnRuntime, textOf } from "../runtime.ts";

const EDIT_TOOLS = ["edit", "write"];

/**
 * D1: "done" after an edit that nothing has run since is a claim, not a
 * result. The harness knows the facts (what was edited, what ran afterwards);
 * the judge reads the closing message. At most one nudge per user turn.
 */
export function registerCompletion(runtime: KyrnRuntime): void {
	const options = runtime.options("completion", { enabled: true });
	if (!options.enabled) return;
	const { pi } = runtime;

	pi.on(
		"tool_result",
		failOpen((event) => {
			if (event.isError) return undefined;
			const toolName = "toolName" in event ? String(event.toolName) : "";
			if (EDIT_TOOLS.includes(toolName)) {
				runtime.turn.editedFiles.add(String((event.input as { path?: unknown }).path ?? "?"));
				runtime.turn.ranCommandAfterLastEdit = false;
			} else if (toolName === "bash" && runtime.turn.editedFiles.size > 0) {
				runtime.turn.ranCommandAfterLastEdit = true;
			}
			return undefined;
		}),
	);

	pi.on(
		"agent_end",
		failOpen<AgentEndEvent, undefined>(async (event, ctx) => {
			runtime.touch(ctx);
			const turn = runtime.turn;
			if (turn.nudgedForCompletion || turn.editedFiles.size === 0 || turn.ranCommandAfterLastEdit) return undefined;
			const last = [...event.messages].reverse().find((message) => message.role === "assistant");
			const finalMessage = last ? textOf((last as { content?: unknown }).content) : "";
			if (!finalMessage.trim()) return undefined;

			const decision = await runtime.engine.decide(turnCompletion, {
				userMessage: clip(turn.userMessage, 400),
				finalMessage: clip(finalMessage, 600),
				editedFiles: turn.editedFiles.size,
				ranCommandAfterLastEdit: turn.ranCommandAfterLastEdit,
			});
			if (decision.source !== "judge" || decision.outcome !== "nudge") return undefined;
			turn.nudgedForCompletion = true;
			pi.sendMessage(
				{
					customType: "kyrn.nudge",
					content: `You edited ${[...turn.editedFiles].join(", ")} and nothing has run since. Verify the change (run the relevant test, build or command), or say plainly why it cannot be verified here.`,
					display: true,
				},
				{ triggerTurn: true },
			);
			return undefined;
		}),
	);
}
