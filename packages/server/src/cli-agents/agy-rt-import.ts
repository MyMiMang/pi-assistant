import { accountJournal, acceptAccountJournal, identityDigest, newAccountGeneration, recoverAccountJournal, writeAccountJournal } from "./agy-account-journal.ts";
import { agyAccountGate } from "./agy-account-gate.ts";

export type AgyAccount = Readonly<{ subject: string; email: string }>;
export type AgyAccountRow = AgyAccount & { state: "ready" | "invalid" | "unknown" };
type Candidate = { readAccount(signal: AbortSignal): Promise<AgyAccount | null>; discard(): Promise<void> };

/** Trusted integration only: commit switches atomically under the same lease as CLI launches.
 * Account material lives in an isolated protected store, never in the account list. */
export interface AgyRtBackend {
	current(signal: AbortSignal): Promise<AgyAccount | null>;
	list(): Promise<AgyAccountRow[]>;
	verify(material: string, signal: AbortSignal): Promise<AgyAccount | null>;
	remember(account: AgyAccount, material: string, signal: AbortSignal): Promise<void>;
	stored(subject: string): Promise<string | null>;
	markInvalid(subject: string): Promise<void>;
	stage(material: string, account: AgyAccount, signal: AbortSignal): Promise<Candidate>;
	activate(candidate: Candidate, expected: AgyAccount | null, signal: AbortSignal): Promise<boolean>;
	rollback(candidate: Candidate, previous: AgyAccount | null): Promise<void>;
	removeInactive(subject: string, signal: AbortSignal): Promise<boolean>;
}

export class AgyRtError extends Error {
	constructor(readonly code: "invalid_input" | "occupied" | "invalid_account" | "cli_unverified" | "cancelled" | "import_failed" | "import_unavailable") { super(code); }
}

export function createAgyRtImport(backend: AgyRtBackend) {
	let busy = false;
	const recovery = recoverAccountJournal(() => backend.current(AbortSignal.timeout(5000))).catch(() => {});
	async function mutate(op: "add" | "switch" | "remove", input: unknown, signal: AbortSignal) {
		const { refreshToken, subject } = (input ?? {}) as Record<string, unknown>;
		if (busy) throw new AgyRtError("occupied");
		busy = true;
		let candidate: Candidate | undefined;
		let release: (() => void) | undefined;
		const check = () => { if (signal.aborted) throw new AgyRtError("cancelled"); };
		try {
			await recovery;
			check();
			if (op === "add") {
				if (typeof refreshToken !== "string" || !/^[\x21-\x7e]{16,4096}$/.test(refreshToken)) throw new AgyRtError("invalid_input");
				const account = await backend.verify(refreshToken, signal);
				check();
				if (!account?.subject || account.subject.length > 256 || typeof account.email !== "string" || !account.email.trim() || account.email.length > 254) throw new AgyRtError("invalid_account");
				await backend.remember(account, refreshToken, signal);
				return { email: account.email };
			}
			if (typeof subject !== "string" || !subject || subject.length > 256) throw new AgyRtError("invalid_input");
			if (op === "remove") {
				if (!(await backend.removeInactive(subject, signal))) throw new AgyRtError("occupied");
				return { ok: true };
			}
			if (accountJournal()?.phase === "pending") throw new AgyRtError("cli_unverified");
			release = await agyAccountGate.manage() ?? undefined;
			if (!release) throw new AgyRtError("occupied");
			const expected = await backend.current(signal);
			check();
			const material = await backend.stored(subject);
			if (!material) throw new AgyRtError("invalid_account");
			check();
			const account = await backend.verify(material, signal);
			check();
			if (account?.subject !== subject) {
				await backend.markInvalid(subject);
				throw new AgyRtError("invalid_account");
			}
			candidate = await backend.stage(material, account, signal);
			check();
			const actual = await candidate.readAccount(signal);
			check();
			if (!actual || actual.subject !== account.subject || actual.email.toLowerCase() !== account.email.toLowerCase()) throw new AgyRtError("cli_unverified");
			const previous = accountJournal();
			const generation = newAccountGeneration();
			writeAccountJournal({ phase: "pending", before: identityDigest(expected), after: identityDigest(account)!, generation });
			let unchanged = false;
			try {
				unchanged = !(await backend.activate(candidate, expected, signal));
				if (unchanged) throw new AgyRtError("occupied");
				check();
				const committed = await backend.current(signal);
				check();
				if (committed?.subject !== account.subject || committed?.email.toLowerCase() !== account.email.toLowerCase()) throw new AgyRtError("cli_unverified");
				acceptAccountJournal({ phase: "verified", subject: identityDigest(account), generation });
			} catch (error) {
				if (unchanged) writeAccountJournal(previous);
				else {
					try {
						await backend.rollback(candidate, expected);
						const restored = await backend.current(AbortSignal.timeout(5_000));
						if (restored?.subject !== expected?.subject || restored?.email !== expected?.email) throw new Error("rollback_unverified");
						acceptAccountJournal({ phase: "verified", subject: identityDigest(restored), generation });
					} catch { agyAccountGate.quarantine(); }
				}
				throw error;
			}
			return { email: account.email };
		} catch (err) {
			if (err instanceof AgyRtError) throw err;
			check();
			throw new AgyRtError("import_failed");
		} finally {
			try { await candidate?.discard(); } catch { /* staged state must remain inaccessible */ }
			release?.();
			busy = false;
		}
	}
	return { mutate, async status(signal: AbortSignal) {
		await recovery;
		const revision = agyAccountGate.readRevision();
		const current = revision === null ? null : await backend.current(signal);
		const accounts = await backend.list();
		return { available: true, current: revision === agyAccountGate.readRevision() ? current : null, accounts };
	} };
}
