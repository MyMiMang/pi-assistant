import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgyAccount } from "./agy-rt-import.ts";

export const AGY_SEED_ACCESS_MARKER = "expired";

export interface AgyTokenFileData {
	accessToken?: string;
	refreshToken?: string;
	idToken?: string;
	expiry?: string;
}

export const agyTokenFilePath = (home: string): string => join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");

export function writeAgyTokenFileAtomic(filePath: string, content: string): void {
	const dir = dirname(filePath);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
	try { chmodSync(tmp, 0o600); } catch {}
	renameSync(tmp, filePath);
}

/** 写入过期种子文件，让受管 agy 自行用内置客户端刷新 RT，不在 Pi 内保存第三方 OAuth 密钥。 */
export function writeAgySeedTokenFile(home: string, refreshToken: string): string {
	const filePath = agyTokenFilePath(home);
	const payload = JSON.stringify({
		token: {
			access_token: AGY_SEED_ACCESS_MARKER,
			token_type: "Bearer",
			refresh_token: refreshToken,
			expiry: "2020-01-01T00:00:00.000000Z",
		},
		auth_method: "consumer",
	});
	writeAgyTokenFileAtomic(filePath, payload);
	return filePath;
}

export function readAgyTokenFile(home: string): { raw: string; parsed: AgyTokenFileData } | null {
	const filePath = agyTokenFilePath(home);
	if (!existsSync(filePath)) return null;
	try {
		const raw = readFileSync(filePath, "utf8");
		const json = JSON.parse(raw) as { token?: { access_token?: unknown; refresh_token?: unknown; expiry?: unknown }; id_token?: unknown };
		return {
			raw,
			parsed: {
				accessToken: typeof json?.token?.access_token === "string" ? json.token.access_token : undefined,
				refreshToken: typeof json?.token?.refresh_token === "string" ? json.token.refresh_token : undefined,
				expiry: typeof json?.token?.expiry === "string" ? json.token.expiry : undefined,
				idToken: typeof json?.id_token === "string" ? json.id_token : undefined,
			},
		};
	} catch {
		return null;
	}
}

export function extractJwtIdentity(idToken: string): AgyAccount | null {
	const parts = idToken.split(".");
	if (parts.length !== 3) return null;
	try {
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { sub?: unknown; email?: unknown; email_verified?: unknown };
		if (typeof payload.sub !== "string" || !payload.sub || typeof payload.email !== "string" || !payload.email.trim()) return null;
		if (payload.email_verified === false) return null;
		return { subject: payload.sub, email: payload.email.trim() };
	} catch {
		return null;
	}
}

export async function fetchGoogleUserInfo(accessToken: string, signal: AbortSignal, send = fetch): Promise<AgyAccount | null> {
	const profile = await send("https://openidconnect.googleapis.com/v1/userinfo", {
		headers: { Authorization: `Bearer ${accessToken}` },
		redirect: "error",
		signal,
		cache: "no-store",
	});
	if (!profile.ok) return null;
	const identity = await profile.json() as { sub?: unknown; email?: unknown; email_verified?: unknown };
	if (typeof identity.sub !== "string" || !identity.sub || typeof identity.email !== "string" || !identity.email.trim() || identity.email_verified === false) return null;
	return { subject: identity.sub, email: identity.email.trim() };
}

/** Construct only with a client provisioned for this app and authorized by its provider.
 * This verifies the OAuth account; it does not activate an Antigravity CLI profile. */
export function googleAgyIdentity(client: { id: string; secret?: string }, send = fetch) {
	if (!client.id.trim()) throw new Error("oauth_client_unavailable");
	return async (material: string, signal: AbortSignal): Promise<AgyAccount | null> => {
		const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: material, client_id: client.id });
		if (client.secret) body.set("client_secret", client.secret);
		const response = await send("https://oauth2.googleapis.com/token", { method: "POST", body, redirect: "error", signal, cache: "no-store" });
		const data = await response.json() as { error?: string; access_token?: string; token_type?: string };
		if (response.status === 400 && data.error === "invalid_grant") return null;
		if (!response.ok || data.token_type?.toLowerCase() !== "bearer" || !data.access_token) throw new Error("oauth_refresh_unavailable");
		const profile = await send("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${data.access_token}` }, redirect: "error", signal, cache: "no-store" });
		if (!profile.ok) throw new Error("oauth_identity_unavailable");
		const identity = await profile.json() as { sub?: unknown; email?: unknown; email_verified?: unknown };
		if (typeof identity.sub !== "string" || !identity.sub || typeof identity.email !== "string" || !identity.email || identity.email_verified !== true) return null;
		return { subject: identity.sub, email: identity.email };
	};
}
