import { EventEmitter } from "node:events";
import * as undici from "undici";
import { muEnv } from "../naming.ts";

/** How long an idle connection to a judge stays open. Between two tool calls the model thinks for longer than Node's 4 s. */
export const JUDGE_KEEP_ALIVE_MS = 60_000;

export interface JudgeFetch {
	readonly fetch: typeof fetch;
	/** Whether HTTP/2 is offered to the judge. `MU_JUDGE_HTTP2=off` keeps to HTTP/1.1, for a proxy that cannot carry it. */
	readonly http2: boolean;
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
 *
 * HTTP/2 where the judge speaks it (api.typesafe.ai does): the questions asked
 * before a turn then share one connection instead of each opening its own.
 * Measured 2026-09-23, five questions at once on cold connections: 3.9 s over
 * HTTP/1.1, 1.7 s over HTTP/2; warm, 0.5 s against 0.3 s per question.
 */
export function createJudgeFetch(options: { keepAliveMs?: number; http2?: boolean } = {}): JudgeFetch {
	const keepAliveMs = options.keepAliveMs ?? JUDGE_KEEP_ALIVE_MS;
	const http2 = options.http2 ?? muEnv("JUDGE_HTTP2") !== "off";
	const dispatcher = new undici.EnvHttpProxyAgent({
		keepAliveTimeout: keepAliveMs,
		keepAliveMaxTimeout: Math.max(keepAliveMs, 600_000),
		// Judge calls are small and short: a few connections per origin cover what a turn asks at once.
		connections: 4,
		allowH2: http2,
	});
	// A connection that dies while idle raises an "error" event on the dispatcher; without a listener it would crash the host.
	if (dispatcher instanceof EventEmitter) EventEmitter.prototype.on.call(dispatcher, "error", () => {});
	const withDispatcher = undici.fetch as unknown as typeof fetch;
	const judgeFetch: typeof fetch = (input, init) =>
		withDispatcher(input, { ...(init ?? {}), dispatcher } as unknown as RequestInit);
	return { fetch: judgeFetch, http2, close: () => dispatcher.close() };
}
