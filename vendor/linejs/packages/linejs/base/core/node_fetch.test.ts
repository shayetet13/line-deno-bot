import { assertEquals } from "@std/assert";
import { BaseClient } from "./mod.ts";
import { createNodeFetch } from "./node_fetch.ts";

Deno.test("Node dispatchers are not used on Deno", async () => {
	assertEquals(await createNodeFetch(false)(30_000), null);
	assertEquals(await createNodeFetch(true)(30_000), null);
});

Deno.test("PUSH can use a streaming transport separate from buffered RPC fetch", async () => {
	const rpcRequests: Request[] = [];
	const pushRequests: Request[] = [];
	const client = new BaseClient({
		device: "DESKTOPWIN",
		fetch: (info) => {
			rpcRequests.push(new Request(info));
			return Promise.resolve(new Response("ok"));
		},
		pushFetch: (info) => {
			pushRequests.push(new Request(info));
			return Promise.resolve(new Response("ok"));
		},
	});
	const controller = new AbortController();
	await client.fetch("https://example.invalid/rpc", {
		signal: controller.signal,
	});
	await client.fetchPush("https://example.invalid/push", {
		signal: controller.signal,
	});
	assertEquals(rpcRequests.length, 1);
	assertEquals(pushRequests.length, 1);
	controller.abort();
	assertEquals(rpcRequests[0]?.signal.aborted, true);
	assertEquals(pushRequests[0]?.signal.aborted, true);
});
