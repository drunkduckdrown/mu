import { EventEmitter } from "node:events";
import * as undici from "undici";

/** How long an idle connection to a judge stays open. Between two tool calls the model thinks for longer than Node's 4 s. */
export const JUDGE_KEEP_ALIVE_MS = 60_000;

export interface JudgeFetch {
	readonly fetch: typeof fetch;
	close(): Promise<void>;
}

/**
 * A `fetch` for judge calls that keeps its connections open between calls.
 *
 * Node keeps an idle connection for 4 s, and the agent thinks for longer than
 * that between two tool calls, so nearly every judge call paid for a new TLS
 * handshake. Measured from the user's network on 2026-09-22 (api.typesafe.ai,
 * one tiny question, 8 s between calls): 0.7-1.9 s per call on the default
 * dispatcher, 0.25-0.36 s on one that keeps the connection. Proxies from the
 * environment are honoured, as pi honours them for the model.
 */
export function createJudgeFetch(options: { keepAliveMs?: number } = {}): JudgeFetch {
	const keepAliveMs = options.keepAliveMs ?? JUDGE_KEEP_ALIVE_MS;
	const dispatcher = new undici.EnvHttpProxyAgent({
		keepAliveTimeout: keepAliveMs,
		keepAliveMaxTimeout: Math.max(keepAliveMs, 600_000),
		// Judge calls are small and short: a few connections per origin cover a batch of chunk verdicts.
		connections: 4,
	});
	// A connection that dies while idle raises an "error" event on the dispatcher; without a listener it would crash the host.
	if (dispatcher instanceof EventEmitter) EventEmitter.prototype.on.call(dispatcher, "error", () => {});
	const withDispatcher = undici.fetch as unknown as typeof fetch;
	const judgeFetch: typeof fetch = (input, init) =>
		withDispatcher(input, { ...(init ?? {}), dispatcher } as unknown as RequestInit);
	return { fetch: judgeFetch, close: () => dispatcher.close() };
}
