import "./setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { normalizeContext, type AssistantMessage, type Message, type Model, type UserMessage } from "@earendil-works/pi-ai";
import { Hono } from "hono";
import type { AgyAccount, AgyRtBackend } from "../src/cli-agents/agy-rt-import.ts";

const exec = promisify(execFile);
const a = { subject: "fixture-a", email: "a@fixture.test" };
const b = { subject: "fixture-b", email: "b@fixture.test" };
const cases = ["verified-a", "verified-b", "pending-a", "pending-b", "pending-unknown"] as const;
type Scenario = typeof cases[number];
const user = (content: string, timestamp: number): UserMessage => ({ role: "user", content, timestamp });
const original = user("fixture history from account A", 1);
const next = user("fixture new message", 2);
const privatePrompt = "fixture old system instruction\n<memory>fixture old recall</memory>";
const fake = join(import.meta.dirname, "fixtures", "fake-agy.mjs");

type Trace =
	| { event: "launch"; conversationId: string; conversation: string | null }
	| { event: "turn"; conversationId: string; text: string };

async function processPhase(phase: "seed" | "restart", dir: string, scenario: Scenario) {
	// setup.ts protects the test runner. Only these fresh workers reopen the shared temporary DB.
	process.env.PIA_DATA_DIR = dir;
	process.env.PIA_WORKSPACE = join(dir, "workspace");
	const livePath = join(dir, "fake-active.json");
	const snapshotPath = join(dir, "seed-turn.json");
	const launchPath = join(dir, `${phase}-trace.jsonl`);
	const { config } = await import("../src/config.ts");
	assert.equal(config.dataDir, dir);
	const { acceptAccountJournal, accountJournal, accountScope, identityDigest, newAccountGeneration, writeAccountJournal } = await import("../src/cli-agents/agy-account-journal.ts");
	const { createAgyRtImport } = await import("../src/cli-agents/agy-rt-import.ts");
	const { parseAgyModels } = await import("../src/cli-agents/agy-models.ts");
	const { ANTIGRAVITY_API, ANTIGRAVITY_PROVIDER, createAntigravityChannel } = await import("../src/pi-adapter/cli-models/antigravity.ts");
	const { mountToolBridgeRoutes } = await import("../src/routes/tool-bridge.ts");
	const unsupported = async (): Promise<never> => { throw new Error("unexpected fixture backend mutation"); };
	const backend: AgyRtBackend = {
		current: async () => JSON.parse(await readFile(livePath, "utf8")) as AgyAccount | null,
		list: async () => [],
		verify: unsupported, remember: unsupported, stored: unsupported, markInvalid: unsupported,
		stage: unsupported, activate: unsupported, rollback: unsupported, removeInactive: unsupported,
	};
	const app = new Hono<import("../src/routes/common.ts").Env>();
	mountToolBridgeRoutes(app);
	const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
	await once(server, "listening");
	const channel = createAntigravityChannel({
		dataDir: dir,
		bridgeBaseUrl: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		command: () => process.execPath,
		commandArgs: () => [fake],
		extraEnv: () => ({ FAKE_AGY_TRACE: launchPath, FAKE_AGY_SCENARIO: "text" }),
		families: parseAgyModels("claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)"),
	});
	const model: Model<typeof ANTIGRAVITY_API> = {
		id: "claude-sonnet-5-5", name: "Fixture", api: ANTIGRAVITY_API, provider: ANTIGRAVITY_PROVIDER,
		baseUrl: "antigravity://local", input: ["text"], reasoning: true,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 64_000,
	};
	const tools = [{ name: "echo", description: "Fixture tool", parameters: { type: "object" as const, properties: {} } }];
	const turn = async (messages: Message[]) => {
		const stream = channel.streamSimple(model, normalizeContext({ messages, systemPrompt: privatePrompt, tools }), {
			sessionId: "same-pi-session", signal: AbortSignal.timeout(5_000),
		});
		for await (const _ of stream) { /* drain the real channel stream */ }
		return stream.result();
	};
	const trace = async () => (await readFile(launchPath, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Trace);
	const noLaunch = async (messages: Message[]) => {
		const result = await turn(messages);
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /账号.*尚未核对/);
		await assert.rejects(readFile(launchPath), { code: "ENOENT" });
	};

	try {
		if (phase === "seed") {
			const generation = newAccountGeneration();
			acceptAccountJournal({ phase: "verified", subject: identityDigest(a), generation });
			const scope = accountScope();
			assert.ok(scope && scope !== "legacy");
			const reply = await turn([original]);
			assert.equal(reply.stopReason, "stop", reply.errorMessage ?? "fixture seed turn failed");
			const [launch, input] = await trace();
			assert.ok(launch?.event === "launch" && input?.event === "turn");
			assert.equal(launch.conversation, null);
			assert.ok(input.text.includes(String(original.content)));
			assert.equal(channel.store.get("same-pi-session")?.claudeSessionId, launch.conversationId);
			await writeFile(snapshotPath, JSON.stringify({ pid: process.pid, scope, reply, conversation: launch.conversationId }));
			// Recreate the precise durable boundary left by an interrupted switch. Neither
			// the live identity nor the journal gets changed by shutting down this worker.
			const active = scenario.endsWith("-a") ? a : scenario.endsWith("-b") ? b : null;
			await writeFile(livePath, JSON.stringify(active));
			if (scenario.startsWith("pending-")) {
				writeAccountJournal({ phase: "pending", before: identityDigest(a), after: identityDigest(b)!, generation: newAccountGeneration() });
				assert.equal(accountScope(), null);
			} else if (scenario === "verified-b") {
				acceptAccountJournal({ phase: "verified", subject: identityDigest(b), generation: newAccountGeneration() });
			}
			return;
		}

		const seed = JSON.parse(await readFile(snapshotPath, "utf8")) as { pid: number; scope: string; reply: AssistantMessage; conversation: string };
		assert.notEqual(process.pid, seed.pid);
		const saved = accountJournal();
		assert.equal(saved?.phase, scenario.startsWith("pending-") ? "pending" : "verified");
		const messages = [original, seed.reply, next];
		assert.equal(accountScope(), null, "a new process must not trust the journal without checking the live identity");
		await noLaunch(messages);
		const status = await createAgyRtImport(backend).status(AbortSignal.timeout(5_000));
		if (scenario === "pending-b" || scenario === "pending-unknown") {
			assert.equal(accountScope(), null);
			assert.deepEqual(accountJournal(), saved, "an ambiguous transition must stay pending");
			await noLaunch(messages);
			return;
		}

		const expected = scenario === "verified-b" ? b : a;
		assert.deepEqual(status.current, expected);
		const scope = accountScope();
		assert.ok(scope && scope !== "legacy");
		assert.equal(accountJournal()?.phase, "verified");
		const resume = scenario === "verified-a";
		if (resume) assert.equal(scope, seed.scope);
		else assert.notEqual(scope, seed.scope);
		// The stale entry and its matching history are really present on restart.
		assert.equal(channel.store.get("same-pi-session")?.claudeSessionId, seed.conversation);
		const result = await turn(messages);
		assert.equal(result.stopReason, "stop", result.errorMessage ?? "fixture restart turn failed");
		const events = await trace();
		assert.equal(events.length, 2, "exactly one fake launch and one input");
		const [launch, input] = events;
		assert.ok(launch.event === "launch" && input.event === "turn");
		assert.equal(launch.conversation, resume ? seed.conversation : null);
		if (resume) {
			assert.equal(input.conversationId, seed.conversation);
			assert.ok(input.text.includes(String(next.content)));
		} else {
			assert.notEqual(input.conversationId, seed.conversation);
			assert.ok(input.text.includes(String(next.content)), "fresh turn on switched account keeps user prompt");
		}
	} finally {
		channel.disposeAll();
		(server as import("node:http").Server).closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
}

if (process.argv[2] === "--agy-restart-worker") {
	const [, , , phase, dir, scenario] = process.argv;
	assert.ok((phase === "seed" || phase === "restart") && dir && cases.includes(scenario as Scenario));
	await processPhase(phase, dir, scenario as Scenario);
} else {
	for (const scenario of cases) test(`agy account restart: ${scenario}`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "pia-agy-restart-"));
		try {
			for (const phase of ["seed", "restart"]) {
				await exec(process.execPath, ["--import", "tsx", import.meta.filename, "--agy-restart-worker", phase, dir, scenario], {
					cwd: join(import.meta.dirname, ".."), timeout: 15_000, windowsHide: true,
					env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: dir, USERPROFILE: dir, TMPDIR: dir, TMP: dir, TEMP: dir },
				});
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
}
