import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { getSetting, setSetting } from "../db.ts";
import type { AgyAccount } from "./agy-rt-import.ts";
import { agyAccountGate } from "./agy-account-gate.ts";

type Journal = { phase: "pending"; before: string | null; after: string; generation: string } | { phase: "verified"; subject: string | null; generation: string };
const key = "agyAccountTransitionV1";
const activeRtKey = "agyActiveRtAccountV1";
export const identityDigest = (account: AgyAccount | null) => account ? createHash("sha256").update(account.subject).digest("hex") : null;
export const accountJournal = () => getSetting<Journal | null>(key, null);
export const newAccountGeneration = () => randomUUID();
export function writeAccountJournal(value: Journal | null) { setSetting(key, value); }

/** 当前激活的 RT 账号；null 表示使用原本的 Google 登录环境。 */
export function activeAgyRtAccount(): AgyAccount | null {
	try {
		const saved = getSetting<AgyAccount | null>(activeRtKey, null);
		return saved && typeof saved.subject === "string" && saved.subject && typeof saved.email === "string" ? saved : null;
	} catch {
		return null;
	}
}
export function setActiveAgyRtAccount(account: AgyAccount | null) { setSetting(activeRtKey, account); }
export const agyRtHomeDir = (dataDir: string, subject: string): string =>
	join(dataDir, "cli-agents", "antigravity", "rt-homes", createHash("sha256").update(subject).digest("hex").slice(0, 24));
export function activeAgyRtHome(dataDir: string): string | null {
	const active = activeAgyRtAccount();
	return active ? agyRtHomeDir(dataDir, active.subject) : null;
}

// Even a previously verified record must be checked against the actual managed state
// on every new server process. Managed login without an adapter never clears a journal.
let verifiedHere: string | null = null;
export function acceptAccountJournal(value: Journal) {
	if (value.phase !== "verified") throw new Error("account_unverified");
	writeAccountJournal(value);
	verifiedHere = value.generation;
}
export function accountScope(): string | null {
	const activeRt = activeAgyRtAccount();
	if (activeRt) return `rt:${identityDigest(activeRt)}`;
	const journal = accountJournal();
	if (!journal) return "legacy";
	return journal.phase === "verified" && !!journal.subject && journal.generation === verifiedHere ? `${journal.subject}:${journal.generation}` : null;
}
export function blockUnverifiedAccount() { verifiedHere = null; }
export async function recoverAccountJournal(read: () => Promise<AgyAccount | null>) {
	const saved = accountJournal();
	if (!saved) return;
	const release = agyAccountGate.switchAccount();
	if (!release) return;
	try {
		const account = await read();
		const digest = identityDigest(account);
		// Interrupted transitions are fail closed, including a readable target: it
		// cannot prove that all phases of the original transaction completed.
		if (saved.phase === "verified" && digest && digest === saved.subject) verifiedHere = saved.generation;
		else if (saved.phase === "pending" && digest && digest === saved.before) acceptAccountJournal({ phase: "verified", subject: digest, generation: saved.generation });
	} finally { release(); }
}
