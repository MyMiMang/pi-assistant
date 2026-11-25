import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { getSetting, setSetting } from "../db.ts";
import { EncryptedCredentialStore } from "../secrets.ts";
import { agyAccountGate } from "./agy-account-gate.ts";
import { activeAgyRtAccount, agyRtHomeDir, setActiveAgyRtAccount } from "./agy-account-journal.ts";
import { buildAgyEnv } from "./agy-launch.ts";
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
import { terminalAuth } from "./terminal-auth.ts";

const storageKey = "agyPrivateAccountsV1";
export type AgyAccountSource = "rt" | "google";
type Entry = { account: AgyAccount; material: string; state?: AgyAccountRow["state"]; source?: AgyAccountSource };
export type AgyGoogleLoginStatus =
	| { state: "running" }
	| { state: "succeeded"; email: string }
	| { state: "failed"; code: AgyRtError["code"] }
	| { state: "cancelled" };

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
	/** 测试可注入假 Google 终端登录，生产默认在隔离目录运行受管 `agy acp --login` */
	loginCli?: (home: string, signal: AbortSignal) => Promise<void>;
}

const fallbackIdentity = (refreshToken: string, source: AgyAccountSource): AgyAccount => {
	const digest = createHash("sha256").update(refreshToken).digest("hex");
	return { subject: `rt:${digest.slice(0, 16)}`, email: `${source === "google" ? "Google 账号" : "RT 账号"} (${digest.slice(0, 6)})` };
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
	loginCli,
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

	async function verifyStageCli(stageDir: string, signal: AbortSignal) {
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
	}

	async function resolveIdentity(after: ReturnType<typeof readAgyTokenFile>, latestRefreshToken: string, source: AgyAccountSource, signal: AbortSignal) {
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
		if (!account) account = fallbackIdentity(latestRefreshToken, source);
		if (account.subject.length > 256 || !account.email.trim() || account.email.length > 254) {
			throw new AgyRtError("invalid_account");
		}
		return account;
	}

	async function probeInStage(refreshToken: string, existingHome: string | null, signal: AbortSignal, source: AgyAccountSource = "rt") {
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
			await verifyStageCli(stageDir, signal);
			signal.throwIfAborted();

			const after = readAgyTokenFile(stageDir);
			const latestRefreshToken = after?.parsed.refreshToken?.trim() || refreshToken;
			const rawContent = after?.raw ?? JSON.stringify({
				token: { access_token: AGY_SEED_ACCESS_MARKER, token_type: "Bearer", refresh_token: latestRefreshToken, expiry: "2020-01-01T00:00:00.000000Z" },
				auth_method: "consumer",
			});
			const account = await resolveIdentity(after, latestRefreshToken, source, signal);
			return { account, latestRefreshToken, rawContent };
		} finally {
			await rm(stageDir, { recursive: true, force: true }).catch(() => {});
		}
	}

	let busy = false;
	let googleLogin: AgyGoogleLoginStatus | null = null;
	let googleLoginController: AbortController | null = null;
	return {
		async status() {
			const s = vault();
			const hasCli = !!probeCli || !!resolveCliCommand();
			const hasGoogleLogin = !!s && (!!loginCli || !!resolveCliCommand()) && hasCli;
			const current = activeAgyRtAccount();
			return {
				available: !!s,
				canAdd: !!s && hasCli,
				canSwitch: !!s && hasCli,
				canGoogleLogin: hasGoogleLogin,
				googleLogin,
				current,
				accounts: s ? load(s).map(({ account, state, source }) => ({ ...account, state: state ?? ("ready" as const), source: source ?? ("rt" as const) })) : [],
				addReason: !s ? "protected_storage_unavailable" : !hasCli ? "cli_not_installed" : null,
			};
		},
		startGoogleLogin() {
			const s = vault();
			if (!s) throw new AgyRtError("import_unavailable");
			if ((!loginCli && !resolveCliCommand()) || (!probeCli && !resolveCliCommand())) throw new AgyRtError("import_unavailable");
			if (busy || googleLoginController) throw new AgyRtError("occupied");
			const controller = new AbortController();
			googleLoginController = controller;
			googleLogin = { state: "running" };
			void (async () => {
				const root = join(dataDir(), "cli-agents", "antigravity", "staging");
				mkdirSync(root, { recursive: true, mode: 0o700 });
				const stageDir = await mkdtemp(join(root, "google-login-"));
				try {
					if (loginCli) {
						await loginCli(stageDir, controller.signal);
					} else {
						const cmd = resolveCliCommand();
						if (!cmd) throw new AgyRtError("import_unavailable");
						const env = buildAgyEnv({ dataDir: dataDir(), homeOverride: stageDir });
						await terminalAuth({
							command: cmd,
							args: [...(commandArgs?.() ?? []), "acp", "--login"],
							env,
							root: join(dataDir(), "cli-agents", "antigravity", "auth-runs"),
							signal: controller.signal,
						});
					}
					controller.signal.throwIfAborted();
					const afterLogin = readAgyTokenFile(stageDir);
					const loginRt = afterLogin?.parsed.refreshToken?.trim();
					if (!afterLogin || !loginRt) throw new AgyRtError("cli_unverified");

					await verifyStageCli(stageDir, controller.signal);
					controller.signal.throwIfAborted();

					const after = readAgyTokenFile(stageDir) ?? afterLogin;
					const latestRefreshToken = after.parsed.refreshToken?.trim() || loginRt;
					const account = await resolveIdentity(after, latestRefreshToken, "google", controller.signal);

					const sNow = vault();
					if (!sNow) throw new AgyRtError("import_unavailable");
					const homeDir = agyRtHomeDir(dataDir(), account.subject);
					writeAgyTokenFileAtomic(agyTokenFilePath(homeDir), after.raw);
					const rows = load(sNow).filter(x => x.account.subject !== account.subject);
					save(sNow, [...rows, { account, material: latestRefreshToken, state: "ready", source: "google" }]);
					if (activeAgyRtAccount()?.subject === account.subject) {
						setActiveAgyRtAccount(account);
						if (onAccountChanged) await onAccountChanged().catch(() => {});
					}
					googleLogin = { state: "succeeded", email: account.email };
				} catch (err) {
					if (controller.signal.aborted) googleLogin = { state: "cancelled" };
					else if (err instanceof AgyRtError) googleLogin = { state: "failed", code: err.code };
					else googleLogin = { state: "failed", code: "import_failed" };
				} finally {
					if (googleLoginController === controller) googleLoginController = null;
					await rm(stageDir, { recursive: true, force: true }).catch(() => {});
				}
			})();
			return { started: true };
		},
		cancelGoogleLogin() {
			if (googleLoginController) {
				googleLoginController.abort();
				googleLogin = { state: "cancelled" };
			}
			return { ok: true };
		},
		async mutate(op: "add" | "switch" | "switch-google" | "remove", input: unknown, signal: AbortSignal) {
			const s = vault();
			if (!s) throw new AgyRtError("import_unavailable");
			if (busy || googleLoginController) throw new AgyRtError("occupied");
			busy = true;
			if (googleLogin?.state !== "running") googleLogin = null;
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
					const verified = await probeInStage(refreshToken, null, signal, "rt");
					const homeDir = agyRtHomeDir(dataDir(), verified.account.subject);
					writeAgyTokenFileAtomic(agyTokenFilePath(homeDir), verified.rawContent);
					const rows = load(s).filter(x => x.account.subject !== verified.account.subject);
					save(s, [...rows, { account: verified.account, material: verified.latestRefreshToken, state: "ready", source: "rt" }]);
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
					verified = await probeInStage(target.material, targetHome, signal, target.source ?? "rt");
				} catch (err) {
					if (err instanceof AgyRtError && err.code === "invalid_account") {
						save(s, rows.map(x => x.account.subject === subject ? { ...x, state: "invalid" } : x));
					}
					throw err;
				}
				writeAgyTokenFileAtomic(agyTokenFilePath(targetHome), verified.rawContent);
				const nextEmail = !verified.account.subject.startsWith("rt:") ? verified.account.email : target.account.email;
				const committed: AgyAccount = { subject: target.account.subject, email: nextEmail };
				save(s, rows.map(x => x.account.subject === subject ? { account: committed, material: verified.latestRefreshToken, state: "ready", source: x.source ?? "rt" } : x));
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
