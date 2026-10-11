// 与 OpenClaw 的语义一致的最小实现：去空白、小写，非法字符换成 -，空值 = "default"
export const DEFAULT_ACCOUNT_ID = "default";
export function normalizeAccountId(raw) {
	const s = String(raw ?? "").trim().toLowerCase().replace(/[^a-z0-9._@-]+/g, "-").replace(/^-+|-+$/g, "");
	return s || DEFAULT_ACCOUNT_ID;
}
