import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { makeTempRun, startTempServer, cleanupTempRun } from "./temp-server.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const custom = "/api/models/custom";
export const sharedModel = "fixture/future-shared-r62";
export const existingModel = "fixture-existing-r61";
export const extraModel = "fixture-extra-r63";
export const skippedModel = "fixture-unselected-r64";

const listen = (server) => new Promise((resolve, reject) => {
	server.once("error", reject).listen(0, "127.0.0.1", () => resolve(server.address().port));
});
const close = (server) => new Promise((resolve) => server.close(resolve));

export async function withChannelModelAdd(test) {
	const hits = [];
	const failure = new Set();
	const held = new Map();
	const holdCatalog = (channel) => {
		const started = Promise.withResolvers(), gate = Promise.withResolvers();
		held.set(channel, { started, gate });
		return { started: started.promise, release: () => gate.resolve() };
	};
	const catalogs = {
		a: [{ id: existingModel, input: ["text"] }, { id: sharedModel, input: ["text", "image"], reasoning: true }, { id: extraModel }, { id: skippedModel }],
		b: [{ id: sharedModel, input: ["text"], reasoning: false }],
	};
	const upstream = createServer(async (req, res) => {
		hits.push(`${req.method} ${req.url}`);
		const channel = /^\/(a|b)\/v1\/models$/.exec(req.url)?.[1];
		if (!channel || req.method !== "GET") return res.writeHead(404).end();
		const hold = held.get(channel);
		if (hold) {
			hold.started.resolve();
			await hold.gate.promise;
		}
		if (failure.has(channel)) return res.writeHead(503).end("synthetic catalog unavailable");
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: catalogs[channel] }));
	});
	const probe = createServer();
	const port = await listen(probe);
	await close(probe);
	const run = makeTempRun("pia-channel-model-add-");
	let server;
	try {
		const upstreamPort = await listen(upstream);
		const base = `http://127.0.0.1:${port}`;
		const start = async () => {
			server = startTempServer({ root, port, run });
			for (let i = 0; !(await fetch(`${base}/api/system`).then((r) => r.ok, () => false)); i++) {
				assert.ok(i < 200, "temporary app failed to boot");
				await delay(100);
			}
		};
		await start();
		const request = (path, method = "GET", body) => fetch(base + path, {
			method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
		});
		const json = async (path, method, body) => {
			const res = await request(path, method, body);
			assert.ok(res.ok, `${method ?? "GET"} ${path}: ${res.status} ${res.ok ? "" : await res.text()}`);
			return res.json();
		};
		await json("/api/settings", "PUT", { onboarded: true });
		const seed = (key, models, extra) => json(custom, "POST", {
			name: `本地目录 ${key.toUpperCase()}`, api: "openai-completions", baseUrl: `http://127.0.0.1:${upstreamPort}/${key}/v1`,
			noKey: true, models, ...extra,
		});
		const a = await seed("a", [{ id: existingModel, visionOverride: true }], {
			capabilityScope: { api: "openai-completions", baseUrl: `http://127.0.0.1:${upstreamPort}/a/v1`, source: "本地测试文档", appliesTo: "all-chat", defaults: { reasoning: true, levels: { high: "fixture-high" } } },
		});
		const b = await seed("b", [{ id: sharedModel, visionOverride: false, reasoning: false }]);
		const snapshot = async (id) => (await json(custom)).providers.find((p) => p.id === id);
		const picker = async (id) => (await json(`/api/models?provider=${encodeURIComponent(id)}`));
		const fetchBody = (p) => ({ id: p.id, baseUrl: p.baseUrl, api: p.api });
		const fetchModels = (p) => json(`${custom}/fetch-models`, "POST", fetchBody(p)).then((x) => x.models);
		await test({ base, run, a, b, snapshot, picker, fetchBody, fetchModels, request, json, custom, hits, failure, holdCatalog, catalogs, restart: async () => { await server.stop(); await start(); } });
		assert.ok(hits.every((hit) => /^GET \/[ab]\/v1\/models$/.test(hit)), JSON.stringify(hits));
	} catch (error) {
		if (server) console.error(server.logs());
		throw error;
	} finally {
		for (const { gate } of held.values()) gate.resolve();
		await server?.stop();
		await close(upstream);
		cleanupTempRun(run);
	}
}
