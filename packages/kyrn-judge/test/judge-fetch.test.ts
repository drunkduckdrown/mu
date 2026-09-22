import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createJudgeFetch } from "../src/extension/judge-fetch.ts";

describe("judge fetch", () => {
	const servers: Server[] = [];
	const closers: (() => Promise<void>)[] = [];
	afterEach(async () => {
		for (const close of closers.splice(0)) await close();
		for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
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
