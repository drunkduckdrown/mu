import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJudgeFetch } from "../src/extension/judge-fetch.ts";

describe("judge fetch", () => {
	const servers: Server[] = [];
	const closers: (() => Promise<void>)[] = [];
	afterEach(async () => {
		vi.unstubAllEnvs();
		for (const close of closers.splice(0)) await close();
		for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
	});

	it("offers HTTP/2 to the judge unless told not to", () => {
		const offered = createJudgeFetch();
		closers.push(offered.close);
		expect(offered.http2).toBe(true);
		const declined = createJudgeFetch({ http2: false });
		closers.push(declined.close);
		expect(declined.http2).toBe(false);
		// A proxy that cannot carry HTTP/2 is switched off from the environment, without a config file.
		vi.stubEnv("MU_JUDGE_HTTP2", "off");
		const fromEnv = createJudgeFetch();
		closers.push(fromEnv.close);
		expect(fromEnv.http2).toBe(false);
	});

	it("keeps the connection to the judge open between calls, so only the first call pays for a handshake", async () => {
		let connections = 0;
		const server = createServer((_request, response) => {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ answers: {} }));
		});
		server.on("connection", () => connections++);
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`;

		const judge = createJudgeFetch({ keepAliveMs: 30_000 });
		closers.push(judge.close);
		for (let call = 0; call < 3; call++) {
			const response = await judge.fetch(url, { method: "POST", body: "{}" });
			expect(await response.json()).toEqual({ answers: {} });
			// Between two judge calls the agent thinks for a while; the socket is idle by then, and stays open.
			await new Promise((resolve) => setTimeout(resolve, call === 1 ? 60 : 20));
		}
		expect(connections).toBe(1);
	});
});
