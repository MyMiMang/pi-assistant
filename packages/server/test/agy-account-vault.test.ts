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
const rtC = "synthetic-refresh-token-google-C-0003";
const rtD = "synthetic-refresh-token-google-D-0004";
const profileA = { subject: "google-sub-A", email: "a@fixture.test" };
const profileB = { subject: "google-sub-B", email: "b@fixture.test" };
const profileC = { subject: "google-sub-C", email: "c@fixture.test" };
const profileD = { subject: "google-sub-D", email: "d@fixture.test" };
const path = "/api/agy-rt-import";

async function worker(dir: string, phase: string) {
	assert.equal(process.env.PIA_DATA_DIR, dir);
	const { getSetting } = await import("../src/db.ts");
	const { EncryptedCredentialStore } = await import("../src/secrets.ts");
	const { agyAccountGate } = await import("../src/cli-agents/agy-account-gate.ts");
	const { createAgyAccountVault } = await import("../src/cli-agents/agy-account-vault.ts");
	const { activeAgyRtAccount, agyRtHomeDir } = await import("../src/cli-agents/agy-account-journal.ts");
	const { buildAgyEnv } = await import("../src/cli-agents/agy-launch.ts");
	const { agyTokenFilePath, readAgyTokenFile, writeAgyTokenFileAtomic } = await import("../src/cli-agents/agy-oauth-identity.ts");
	const { mountAgyRtImport } = await import("../src/routes/agy-rt-import.ts");

	const storage = new EncryptedCredentialStore();
	let refreshedCount = 0;
	let failB = false;
	let loginMode: "cancel" | "C" | "D" | "empty" = "C";
	let loginStarted: (() => void) | null = null;
	let loginRelease: Promise<void> | null = null;

	const loginCli = async (stageHome: string, signal: AbortSignal) => {
		loginStarted?.();
		if (loginMode === "cancel") {
			await new Promise<void>((_, reject) => {
				if (signal.aborted) return reject(new Error("aborted"));
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		}
		if (loginRelease) await loginRelease;
		signal.throwIfAborted();
		if (loginMode === "empty") return;
		const rt = loginMode === "C" ? rtC : rtD;
		const access = loginMode === "C" ? "fresh-access-C" : "fresh-access-D";
		writeAgyTokenFileAtomic(agyTokenFilePath(stageHome), JSON.stringify({
			token: { access_token: access, token_type: "Bearer", refresh_token: rt, expiry: "2099-01-01T00:00:00.000000Z" },
			auth_method: "consumer",
		}));
	};

	const probeCli = async (stageHome: string) => {
		const tokenData = readAgyTokenFile(stageHome);
		assert.ok(tokenData, "staging token file must exist");
		const rt = tokenData.parsed.refreshToken;
		const map: Record<string, string> = {
			[rtA]: "fresh-access-A",
			...(failB ? {} : { [rtB]: "fresh-access-B" }),
			[rtC]: "fresh-access-C",
			[rtD]: "fresh-access-D",
		};
		const access = rt ? map[rt] : undefined;
		if (access) {
			await writeFile(agyTokenFilePath(stageHome), JSON.stringify({
				token: { access_token: access, token_type: "Bearer", refresh_token: rt, expiry: "2099-01-01T00:00:00.000000Z" },
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
		if (auth === "Bearer fresh-access-C") return Response.json({ sub: profileC.subject, email: profileC.email, email_verified: true });
		if (auth === "Bearer fresh-access-D") return Response.json({ sub: profileD.subject, email: profileD.email, email_verified: true });
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
		loginCli,
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

	const waitForGoogleLogin = async () => {
		for (let i = 0; i < 60; i++) {
			const s = await status();
			if (s.googleLogin && s.googleLogin.state !== "running") return s;
			await new Promise(r => setTimeout(r, 25));
		}
		throw new Error("google login timed out");
	};

	try {
		if (phase === "add-and-switch") {
			const s0 = await status();
			assert.equal(s0.available, true);
			assert.equal(s0.canAdd, true);
			assert.equal(s0.canSwitch, true);
			assert.equal(s0.canGoogleLogin, true);
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

			// Google login add: cancel preserves active A and does not hold agyAccountGate
			const activeCliLease = agyAccountGate.start();
			assert.ok(activeCliLease, "CLI lease should be available");
			try {
				loginMode = "cancel";
				const started = new Promise<void>(r => { loginStarted = r; });
				assert.equal((await post("/google-login/start", {})).status, 200);
				await started;
				assert.equal((await status()).googleLogin?.state, "running");
				assert.equal((await post("/google-login/start", {})).status, 409);
				assert.equal((await post("/google-login/cancel", {})).status, 200);
				const afterCancel = await waitForGoogleLogin();
				assert.equal(afterCancel.googleLogin?.state, "cancelled");
				assert.deepEqual(afterCancel.current, profileA);

				// Failed Google login (no token written) fails closed and preserves A
				loginMode = "empty";
				loginStarted = null;
				assert.equal((await post("/google-login/start", {})).status, 200);
				const afterEmpty = await waitForGoogleLogin();
				assert.deepEqual(afterEmpty.googleLogin, { state: "failed", code: "cli_unverified" });
				assert.deepEqual(afterEmpty.current, profileA);

				// Add multiple Google accounts (C and D) while CLI lease is held; active stays A
				for (const [mode, prof] of [["C", profileC], ["D", profileD]] as const) {
					loginMode = mode;
					assert.equal((await post("/google-login/start", {})).status, 200);
					const afterAdd = await waitForGoogleLogin();
					assert.deepEqual(afterAdd.googleLogin, { state: "succeeded", email: prof.email });
					assert.deepEqual(afterAdd.current, profileA);
					const row = afterAdd.accounts.find((x: { subject: string }) => x.subject === prof.subject);
					assert.equal(row?.source, "google");
					assert.equal(row?.state, "ready");
					assert.equal(existsSync(agyTokenFilePath(agyRtHomeDir(dir, prof.subject))), true);
					assert.equal(existsSync(join(agyRtHomeDir(dir, prof.subject), "Library", "Keychains")), false);
				}
			} finally {
				activeCliLease();
			}

			// Switch between Google accounts C -> D -> back to A
			assert.equal((await post("/switch", { subject: profileC.subject })).status, 200);
			assert.deepEqual((await status()).current, profileC);
			assert.equal(buildAgyEnv({ dataDir: dir }).HOME, agyRtHomeDir(dir, profileC.subject));
			assert.equal((await post("/switch", { subject: profileD.subject })).status, 200);
			assert.deepEqual((await status()).current, profileD);
			assert.equal((await post("/switch", { subject: profileA.subject })).status, 200);
			assert.deepEqual((await status()).current, profileA);

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
			assert.ok(ciphertext && !ciphertext.includes(rtA) && !ciphertext.includes(rtB) && !ciphertext.includes(rtC) && !ciphertext.includes(rtD) && !ciphertext.includes(profileA.email) && !ciphertext.includes(profileC.email));
		} else {
			// Restart phase: active account B persists across process restart, and all 4 accounts (RT + Google) remain
			const s1 = await status();
			assert.deepEqual(s1.current, profileB);
			assert.equal(s1.accounts.length, 4);
			assert.equal(s1.accounts.find((x: { subject: string }) => x.subject === profileC.subject)?.source, "google");
			assert.equal(buildAgyEnv({ dataDir: dir }).HOME, agyRtHomeDir(dir, profileB.subject));

			// Switch back to original Google login
			const swGoogle = await post("/switch-google", {});
			assert.equal(swGoogle.status, 200);
			assert.equal((await status()).current, null);
			assert.equal(buildAgyEnv({ dataDir: dir }).HOME, join(dir, "cli-agents", "antigravity", "home"));

			// Now all accounts can be removed and their homes deleted
			for (const prof of [profileA, profileB, profileC, profileD]) {
				assert.equal((await post("/remove", { subject: prof.subject })).status, 200);
				assert.equal(existsSync(agyRtHomeDir(dir, prof.subject)), false);
			}
			assert.deepEqual((await status()).accounts, []);
		}
	} finally {
		await new Promise<void>(r => server.close(() => r()));
	}
}

if (process.argv[2] === "--vault-worker") {
	await worker(process.argv[3], process.argv[4]);
} else {
	test("production vault: multi-account RT + Google login add, cancel, isolated switch, failure preserves old, restart, switch-google, remove", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pia-vault-fixture-"));
		try {
			for (const phase of ["add-and-switch", "restart"]) {
				const res = await promisify(execFile)(process.execPath, ["--import", "tsx", import.meta.filename, "--vault-worker", dir, phase], {
					env: { PATH: process.env.PATH, HOME: dir, PIA_DATA_DIR: dir, PIA_SECRETS: "file", PIA_OFFLINE: "1" },
					timeout: 20_000,
				});
				const out = res.stdout + res.stderr;
				assert.ok(!out.includes(rtA) && !out.includes(rtB) && !out.includes(rtC) && !out.includes(rtD));
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
}
