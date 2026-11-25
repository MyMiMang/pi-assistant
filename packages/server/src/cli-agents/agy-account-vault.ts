import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { getSetting, setSetting } from "../db.ts";
import { EncryptedCredentialStore } from "../secrets.ts";
import { agyAccountGate } from "./agy-account-gate.ts";
import { activeAgyRtAccount, agyRtHomeDir, setActiveAgyRtAccount } from "./agy-account-journal.ts";
import { listAgyModels } from "./detect.ts";
import {
	AGY_SEED_ACCESS_MARKER,
	agyTokenFilePath,
	extractJwtIdentity,
	fetchGoogleUserInfo,
	googleAgyIdentity,
	readAgyTokenFile,
	writeAgySeedTokenFile,
	writeAgyTokenFileAtomic,
} from "./agy-oauth-identity.ts";
import { AgyRtError, type AgyAccount, type AgyAccountRow } from "./agy-rt-import.ts";

const storageKey = "agyPrivateAccountsV1";
type Entry = { account: AgyAccount; material: string; state?: AgyAccountRow["state"] };

const AUTH_ERROR_RE = /sign in|log in|login|invalid_grant|unauthenticated|401/i;

export interface AgyAccountVaultOptions {
	storage: () => unknown;
	dataDir: () => string;
	command: () => string | null;
	commandArgs?: () => string[];
	onAccountChanged?: () => Promise<unknown>;
	environment?: Partial<Pick<NodeJS.ProcessEnv, "PIA_AGY_OAUTH_CLIENT_ID" | "PIA_AGY_OAUTH_CLIENT_SECRET">>;
	transport?: typeof fetch;
	/** 测试可注入假 CLI 探测，生产默认调用受管 `agy models` */
	probeCli?: (home: string, signal: AbortSignal) => Promise<void>;
}

const fallbackIdentity = (refreshToken: string): AgyAccount => {
	const digest = createHash("sha256").update(refreshToken).digest("hex");
	return { subject: `rt:${digest.slice(0, 16)}`, email: `RT 账号 (${digest.slice(0, 6)})` };
};

export function createAgyAccountVault({
	storage,
	dataDir,
	command,
	commandArgs,
	onAccountChanged,
	environment = {},
	transport = fetch,
	probeCli,
}: AgyAccountVaultOptions) {
	const id = environment.PIA_AGY_OAUTH_CLIENT_ID?.trim();
	const optionalOAuthVerify = id && /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(id)
		? googleAgyIdentity({ id, secret: environment.PIA_AGY_OAUTH_CLIENT_SECRET }, transport)
		: null;
	const vault = () => {
		const s = storage();
		return s instanceof EncryptedCredentialStore ? s : null;
	};
	function load(s: EncryptedCredentialStore): Entry[] {
		const sealed = getSetting<string | null>(storageKey, null);
		return sealed === null ? [] : s.openPrivateJson<Entry[]>(sealed);
	}
	function save(s: EncryptedCredentialStore, entries: Entry[]) {
		setSetting(storageKey, s.sealPrivateJson(entries));
	}
	function resolveCliCommand(): string | null {
		return command();
	}

	async function probeInStage(refreshToken: string, existingHome: string | null, signal: AbortSignal) {
		const root = join(dataDir(), "cli-agents", "antigravity", "staging");
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const stageDir = await mkdtemp(join(root, "stage-"));
		try {
			const existing = existingHome ? readAgyTokenFile(existingHome) : null;
			const expiryMs = existing?.parsed.expiry ? Date.parse(existing.parsed.expiry) : Number.NaN;
			const reusable = !!existing && existing.parsed.refreshToken === refreshToken
				&& !!existing.parsed.accessToken && existing.parsed.accessToken !== AGY_SEED_ACCESS_MARKER
				&& Number.isFinite(expiryMs) && expiryMs > Date.now() + 60_000;
			if (reusable) writeAgyTokenFileAtomic(agyTokenFilePath(stageDir), existing.raw);
			else writeAgySeedTokenFile(stageDir, refreshToken);

			signal.throwIfAborted();
			try {
				if (probeCli) {
					await probeCli(stageDir, signal);
				} else {
					const cmd = resolveCliCommand();
					if (!cmd) throw new AgyRtError("import_unavailable");
					await listAgyModels(cmd, { dataDir: dataDir(), commandArgs: commandArgs?.(), homeOverride: stageDir, signal, timeoutMs: 35_000 });
				}
			} catch (err) {
				if (signal.aborted) throw new AgyRtError("cancelled");
				if (err instanceof AgyRtError) throw err;
				const msg = err instanceof Error ? err.message : String(err);
				if (AUTH_ERROR_RE.test(msg)) throw new AgyRtError("invalid_account");
				throw new AgyRtError("cli_unverified");
			}
			signal.throwIfAborted();

			const after = readAgyTokenFile(stageDir);
			const latestRefreshToken = after?.parsed.refreshToken?.trim() || refreshToken;
			const rawContent = after?.raw ?? JSON.stringify({
				token: { access_token: AGY_SEED_ACCESS_MARKER, token_type: "Bearer", refresh_token: latestRefreshToken, expiry: "2020-01-01T00:00:00.000000Z" },
				auth_method: "consumer",
			});

			let account: AgyAccount | null = null;
			if (after?.parsed.accessToken && after.parsed.accessToken !== AGY_SEED_ACCESS_MARKER) {
				account = await fetchGoogleUserInfo(after.parsed.accessToken, signal, transport).catch(() => null);
			}
			if (!account && after?.parsed.idToken) {
				account = extractJwtIdentity(after.parsed.idToken);
			}
			if (!account && optionalOAuthVerify) {
				account = await optionalOAuthVerify(latestRefreshToken, signal).catch(() => null);
			}
			if (!account) account = fallbackIdentity(latestRefreshToken);
			if (account.subject.length > 256 || !account.email.trim() || account.email.length > 254) {
				throw new AgyRtError("invalid_account");
			}
			return { account, latestRefreshToken, rawContent };
		} finally {
			await rm(stageDir, { recursive: true, force: true }).catch(() => {});
		}
	}

	let busy = false;
	return {
		async status() {
			const s = vault();
			const hasCli = !!probeCli || !!resolveCliCommand();
			const current = activeAgyRtAccount();
			return {
				available: !!s,
				canAdd: !!s && hasCli,
				canSwitch: !!s && hasCli,
				current,
				accounts: s ? load(s).map(({ account, state }) => ({ ...account, state: state ?? ("ready" as const) })) : [],
				addReason: !s ? "protected_storage_unavailable" : !hasCli ? "cli_not_installed" : null,
			};
		},
		async mutate(op: "add" | "switch" | "switch-google" | "remove", input: unknown, signal: AbortSignal) {
			const s = vault();
			if (!s) throw new AgyRtError("import_unavailable");
			if (busy) throw new AgyRtError("occupied");
			busy = true;
			let release: (() => void) | undefined;
			let notifyChanged = false;
			try {
				const { subject, refreshToken } = (input ?? {}) as Record<string, unknown>;
				signal.throwIfAborted();

				if (op === "remove") {
					if (typeof subject !== "string" || !subject || subject.length > 256) throw new AgyRtError("invalid_input");
					if (activeAgyRtAccount()?.subject === subject) throw new AgyRtError("occupied");
					const rows = load(s);
					const next = rows.filter(x => x.account.subject !== subject);
					if (next.length !== rows.length) {
						save(s, next);
						await rm(agyRtHomeDir(dataDir(), subject), { recursive: true, force: true }).catch(() => {});
					}
					return { ok: true };
				}

				if (op === "switch-google") {
					release = await agyAccountGate.manage() ?? undefined;
					if (!release) throw new AgyRtError("occupied");
					setActiveAgyRtAccount(null);
					notifyChanged = true;
					return { ok: true };
				}

				if (!probeCli && !resolveCliCommand()) throw new AgyRtError("import_unavailable");

				if (op === "add") {
					if (typeof refreshToken !== "string" || !/^[\x21-\x7e]{16,4096}$/.test(refreshToken)) throw new AgyRtError("invalid_input");
					const verified = await probeInStage(refreshToken, null, signal);
					const homeDir = agyRtHomeDir(dataDir(), verified.account.subject);
					writeAgyTokenFileAtomic(agyTokenFilePath(homeDir), verified.rawContent);
					const rows = load(s).filter(x => x.account.subject !== verified.account.subject);
					save(s, [...rows, { account: verified.account, material: verified.latestRefreshToken, state: "ready" }]);
					return { email: verified.account.email, subject: verified.account.subject };
				}

				// op === "switch"
				if (typeof subject !== "string" || !subject || subject.length > 256) throw new AgyRtError("invalid_input");
				release = await agyAccountGate.manage() ?? undefined;
				if (!release) throw new AgyRtError("occupied");
				const rows = load(s);
				const target = rows.find(x => x.account.subject === subject);
				if (!target) throw new AgyRtError("invalid_account");

				const targetHome = agyRtHomeDir(dataDir(), target.account.subject);
				let verified: Awaited<ReturnType<typeof probeInStage>>;
				try {
					verified = await probeInStage(target.material, targetHome, signal);
				} catch (err) {
					if (err instanceof AgyRtError && err.code === "invalid_account") {
						save(s, rows.map(x => x.account.subject === subject ? { ...x, state: "invalid" } : x));
					}
					throw err;
				}
				writeAgyTokenFileAtomic(agyTokenFilePath(targetHome), verified.rawContent);
				const nextEmail = !verified.account.subject.startsWith("rt:") ? verified.account.email : target.account.email;
				const committed: AgyAccount = { subject: target.account.subject, email: nextEmail };
				save(s, rows.map(x => x.account.subject === subject ? { account: committed, material: verified.latestRefreshToken, state: "ready" } : x));
				setActiveAgyRtAccount(committed);
				notifyChanged = true;
				return { email: committed.email, subject: committed.subject };
			} catch (err) {
				if (err instanceof AgyRtError) throw err;
				if (signal.aborted) throw new AgyRtError("cancelled");
				throw new AgyRtError("import_failed");
			} finally {
				release?.();
				busy = false;
				if (notifyChanged && onAccountChanged) {
					await onAccountChanged().catch(() => {});
				}
			}
		},
	};
}
