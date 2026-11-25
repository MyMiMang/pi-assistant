import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Env } from "../src/routes/common.ts";

const rtA = "synthetic-refresh-token-account-A-0001";
const rtB = "synthetic-refresh-token-account-B-0002";
const profileA = { subject: "google-sub-A", email: "a@fixture.test" };
const profileB = { subject: "google-sub-B", email: "b@fixture.test" };
const path = "/api/agy-rt-import";

async function worker(dir: string, phase: string) {
	assert.equal(process.env.PIA_DATA_DIR, dir);
	const { getSetting } = await import("../src/db.ts");
	const { EncryptedCredentialStore } = await import("../src/secrets.ts");
	const { createAgyAccountVault } = await import("../src/cli-agents/agy-account-vault.ts");
	const { activeAgyRtAccount, agyRtHomeDir } = await import("../src/cli-agents/agy-account-journal.ts");
	const { buildAgyEnv } = await import("../src/cli-agents/agy-launch.ts");
	const { agyTokenFilePath, readAgyTokenFile } = await import("../src/cli-agents/agy-oauth-identity.ts");
	const { mountAgyRtImport } = await import("../src/routes/agy-rt-import.ts");

	const storage = new EncryptedCredentialStore();
	let refreshedCount = 0;
	let failB = false;

	const probeCli = async (stageHome: string) => {
		const tokenData = readAgyTokenFile(stageHome);
		assert.ok(tokenData, "staging token file must exist");
		const rt = tokenData.parsed.refreshToken;
		if (rt === rtA) {
			await writeFile(agyTokenFilePath(stageHome), JSON.stringify({
				token: { access_token: "fresh-access-A", token_type: "Bearer", refresh_token: rtA, expiry: "2099-01-01T00:00:00.000000Z" },
				auth_method: "consumer",
			}));
			return;
		}
		if (rt === rtB && !failB) {
			await writeFile(agyTokenFilePath(stageHome), JSON.stringify({
				token: { access_token: "fresh-access-B", token_type: "Bearer", refresh_token: rtB, expiry: "2099-01-01T00:00:00.000000Z" },
				auth_method: "consumer",
			}));
			return;
		}
		throw new Error("Please sign in to view available models.");
	};

	const transport: typeof fetch = async (url, init) => {
		assert.equal(url, "https://openidconnect.googleapis.com/v1/userinfo");
		const auth = new Headers(init?.headers).get("authorization");
		if (auth === "Bearer fresh-access-A") return Response.json({ sub: profileA.subject, email: profileA.email, email_verified: true });
		if (auth === "Bearer fresh-access-B") return Response.json({ sub: profileB.subject, email: profileB.email, email_verified: true });
		return Response.json({ error: "unauthorized" }, { status: 401 });
	};

	const app = new Hono<Env>();
	app.use("*", (c, next) => { c.set("caller", { local: true, deviceId: null, ip: "127.0.0.1" }); return next(); });
	mountAgyRtImport(app, undefined, createAgyAccountVault({
		storage: () => storage,
		dataDir: () => dir,
		command: () => "/usr/bin/true",
		onAccountChanged: async () => { refreshedCount++; },
		transport,
		probeCli,
	}));
	const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
	await once(server, "listening");
	const addr = server.address();
	assert.ok(addr && typeof addr !== "string");
	const origin = `http://127.0.0.1:${addr.port}`;
	const status = async () => (await fetch(origin + path)).json();
	const post = (suffix: string, body: object) => fetch(origin + path + suffix, {
		method: "POST",
		headers: { origin, "content-type": "application/json" },
		body: JSON.stringify(body),
	});

	try {
		if (phase === "add-and-switch") {
			const s0 = await status();
			assert.equal(s0.available, true);
			assert.equal(s0.canAdd, true);
			assert.equal(s0.canSwitch, true);
			assert.equal(s0.current, null);

			// Add A twice (dedup) and B once — adding never auto-switches
			for (let i = 0; i < 2; i++) {
				const addA = await post("", { refreshToken: rtA });
				assert.equal(addA.status, 200);
				assert.equal(addA.headers.get("cache-control"), "no-store");
				assert.deepEqual(await addA.json(), { email: profileA.email, subject: profileA.subject });
			}
			const addB = await post("", { refreshToken: rtB });
			assert.equal(addB.status, 200);
			assert.deepEqual(await addB.json(), { email: profileB.email, subject: profileB.subject });
			assert.equal((await post("", { refreshToken: "invalid-synthetic-token-value" })).status, 400);
			assert.equal((await status()).current, null);
			assert.equal((await status()).accounts.length, 2);

			// Switch to A -> verified and isolated HOME without macOS Keychain symlink
			const swA = await post("/switch", { subject: profileA.subject });
			assert.equal(swA.status, 200);
			assert.deepEqual((await status()).current, profileA);
			assert.equal(refreshedCount, 1);

			const homeA = agyRtHomeDir(dir, profileA.subject);
			const envA = buildAgyEnv({ dataDir: dir });
			assert.equal(envA.HOME, homeA);
			assert.equal(existsSync(join(homeA, "Library", "Keychains")), false, "RT home must not symlink host Keychains");
			assert.equal(existsSync(agyTokenFilePath(homeA)), true);

			// Failed switch to B preserves active account A and marks B invalid
			failB = true;
			const swFail = await post("/switch", { subject: profileB.subject });
			assert.equal(swFail.status, 400);
			assert.deepEqual(activeAgyRtAccount(), profileA);
			assert.equal((await status()).accounts.find((x: { subject: string }) => x.subject === profileB.subject)?.state, "invalid");
			failB = false;

			// Switch to B succeeds
			const swB = await post("/switch", { subject: profileB.subject });
			assert.equal(swB.status, 200);
			assert.deepEqual((await status()).current, profileB);
			assert.equal(buildAgyEnv({ dataDir: dir }).HOME, agyRtHomeDir(dir, profileB.subject));

			// Active account B cannot be removed
			assert.equal((await post("/remove", { subject: profileB.subject })).status, 409);

			// Vault setting is encrypted
			const ciphertext = getSetting<string>("agyPrivateAccountsV1", "");
			assert.ok(ciphertext && !ciphertext.includes(rtA) && !ciphertext.includes(rtB) && !ciphertext.includes(profileA.email));
		} else {
			// Restart phase: active account B persists across process restart
			const s1 = await status();
			assert.deepEqual(s1.current, profileB);
			assert.equal(s1.accounts.length, 2);
			assert.equal(buildAgyEnv({ dataDir: dir }).HOME, agyRtHomeDir(dir, profileB.subject));

			// Switch back to original Google login
			const swGoogle = await post("/switch-google", {});
			assert.equal(swGoogle.status, 200);
			assert.equal((await status()).current, null);
			assert.equal(buildAgyEnv({ dataDir: dir }).HOME, join(dir, "cli-agents", "antigravity", "home"));

			// Now both A and B can be removed and their rt-homes deleted
			assert.equal((await post("/remove", { subject: profileA.subject })).status, 200);
			assert.equal((await post("/remove", { subject: profileB.subject })).status, 200);
			assert.deepEqual((await status()).accounts, []);
			assert.equal(existsSync(agyRtHomeDir(dir, profileA.subject)), false);
			assert.equal(existsSync(agyRtHomeDir(dir, profileB.subject)), false);
		}
	} finally {
		await new Promise<void>(r => server.close(() => r()));
	}
}

if (process.argv[2] === "--vault-worker") {
	await worker(process.argv[3], process.argv[4]);
} else {
	test("production vault: multi-account RT add, isolated switch, failure preserves old, restart, switch-google, remove", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pia-vault-fixture-"));
		try {
			for (const phase of ["add-and-switch", "restart"]) {
				const res = await promisify(execFile)(process.execPath, ["--import", "tsx", import.meta.filename, "--vault-worker", dir, phase], {
					env: { PATH: process.env.PATH, HOME: dir, PIA_DATA_DIR: dir, PIA_SECRETS: "file", PIA_OFFLINE: "1" },
					timeout: 20_000,
				});
				const out = res.stdout + res.stderr;
				assert.ok(!out.includes(rtA) && !out.includes(rtB));
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
}
