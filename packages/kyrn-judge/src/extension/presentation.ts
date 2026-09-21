/** Presentation events contain observed decisions, never generated explanations of hidden reasoning. */
export interface KyrnPresentationEvent {
	version: 1;
	sequence: number;
	at: number;
	runtimeId: string;
	turnId: number;
	kind:
		| "preflight.pending"
		| "preflight.verdict"
		| "preflight.wait_end"
		| "decision"
		| "progress"
		| "memory.stored"
		| "frame.updated"
		| "capability.opened"
		| "inherit.found"
		| "inherit.rule"
		| "mcp.started"
		| "mcp.failed"
		| "mcp.tools_changed"
		| "constraint.blocked"
		| "goal.state"
		| "ttsr.interrupted"
		| "browser.run"
		| "browser.step"
		| "diagnostics.delivered"
		| "diagnostics.held"
		| "diagnostics.dropped"
		| "background.start"
		| "background.exit"
		| "background.stop"
		| "background.match"
		| "web.fetch"
		| "web.search"
		| "context.policy"
		| "compaction.plan";
	payload: unknown;
}

export const PRESENTATION_STATUS_KEY = "kyrn.presentation.v1";
export type PresentationListener = (event: KyrnPresentationEvent) => void;
