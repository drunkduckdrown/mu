import { readFileSync } from "node:fs";
import { SWARM_MESSAGE, toolsClosed, wrapUp } from "../../swarm/markers.ts";
import { failOpen, type KyrnRuntime } from "../runtime.ts";

interface ChildState {
	/** Set once this sub-agent has been asked to stop and report. */
	wrapping: boolean;
	reason: string;
}

const states = new WeakMap<KyrnRuntime, ChildState>();

/** Whether this process is a sub-agent that was told to wrap up. */
export function isWrappingUp(runtime: KyrnRuntime): boolean {
	return states.get(runtime)?.wrapping === true;
}

/**
 * Inside every sub-agent. The parent cannot talk to a print-mode child, so
 * it leaves a request in a file the child looks at between steps. A wrap-up
 * request turns into one message ("report now") and closes the tools, so the
 * child ends with a report instead of being cut off without one.
 */
export function registerSwarmChild(runtime: KyrnRuntime, path: string): void {
	const state: ChildState = { wrapping: false, reason: "" };
	states.set(runtime, state);

	/** "Report now" is a request for what is already known, not for more thought: the report should come quickly. */
	const beginWrapUp = (reason: string) => {
		state.wrapping = true;
		state.reason = reason;
		const level = runtime.pi.getThinkingLevel();
		if (level !== "off" && level !== "minimal" && level !== "low") runtime.pi.setThinkingLevel("low");
	};

	const requested = (): string | undefined => {
		try {
			const request = JSON.parse(readFileSync(path, "utf8")) as { action?: unknown; reason?: unknown };
			if (request.action !== "wrap_up") return undefined;
			return typeof request.reason === "string" && request.reason ? request.reason : "the run is being ended";
		} catch {
			// No file, or one that is still being written: nothing was asked.
			return undefined;
		}
	};

	runtime.pi.on(
		"turn_end",
		failOpen((event) => {
			if (state.wrapping) return undefined;
			const reason = requested();
			if (!reason) return undefined;
			beginWrapUp(reason);
			// A turn without tool calls is already the report; only a bee that would go on needs telling.
			if (event.toolResults.length > 0) {
				runtime.pi.sendMessage(
					{ customType: SWARM_MESSAGE, content: wrapUp(reason), display: true },
					{ deliverAs: "steer" },
				);
			}
			return undefined;
		}),
	);

	runtime.pi.on(
		"tool_call",
		failOpen(() => {
			if (!state.wrapping) {
				const reason = requested();
				if (reason) beginWrapUp(reason);
			}
			return state.wrapping ? { block: true, reason: toolsClosed(state.reason) } : undefined;
		}),
	);
}
