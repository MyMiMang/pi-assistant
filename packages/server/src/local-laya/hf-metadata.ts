/**
 * 只读 HuggingFace **模型元数据**（公开、无需 Key、不下载权重）。
 *
 * 用途：
 *  - 生成 / 复核 checkpoint 固定文件清单（路径 + 大小 + LFS oid=sha256），见 scripts/laya-checkpoint-digests.mjs；
 *  - 单测用本地小 HTTP fixture 验证解析，不发真实网络请求。
 *
 * 只请求 `/api/models/<repo>/revision/<sha>?blobs=true` 这一条 JSON（几 KB），不会拉取任何权重。
 */

export interface HfSibling {
	path: string;
	size: number;
	/** 大文件的 LFS oid（sha256）；小文件为 null，需下载后本地算 */
	lfsSha256: string | null;
}

export function hfMetadataUrl(repo: string, revision: string): string {
	return `https://huggingface.co/api/models/${repo}/revision/${encodeURIComponent(revision)}?blobs=true`;
}

/** 从 HF 元数据 JSON 解析出 sibling 列表；缺字段容错（size 非数字按 0）。 */
export function parseHfSiblings(payload: unknown): HfSibling[] {
	const siblings = (payload as { siblings?: unknown })?.siblings;
	if (!Array.isArray(siblings)) return [];
	return siblings
		.map((s) => {
			const o = s as { rfilename?: unknown; size?: unknown; lfs?: { sha256?: unknown } };
			const path = typeof o.rfilename === "string" ? o.rfilename : "";
			if (!path) return null;
			const size = typeof o.size === "number" ? o.size : 0;
			const oid = typeof o.lfs?.sha256 === "string" ? o.lfs.sha256 : null;
			return { path, size, lfsSha256: oid };
		})
		.filter((s): s is HfSibling => s !== null);
}

/** 取 HF 元数据（可注入 fetch）；HTTP 非 200 直接抛错，绝不把错误当空清单。 */
export async function fetchHfSiblings(repo: string, revision: string, fetchImpl: typeof fetch = fetch): Promise<HfSibling[]> {
	const res = await fetchImpl(hfMetadataUrl(repo, revision), { headers: { accept: "application/json" } });
	if (!res.ok) throw new Error(`HF 元数据请求失败：${repo}@${revision} HTTP ${res.status}`);
	return parseHfSiblings(await res.json());
}

/** HF 缓存里某个 repo 的缓存根目录（`blobs/` 与 `snapshots/` 的父目录，也是 symlink 的合法受信根）。 */
export function hfRepoDir(hfHome: string, repo: string): string {
	return joinPath(hfHome, "hub", `models--${repo.replace(/\//g, "--")}`);
}

/** 自有 HF 缓存的 `hub/` 根目录（`models--…/` 与共享 `blobs/` 的父目录）。 */
export function hfHubDir(hfHome: string): string {
	return joinPath(hfHome, "hub");
}

/**
 * 自有 HF hub 缓存内的**共享 blob**目录。
 *
 * 本机已观察到的缓存形态：较大的 LFS 文件不是普通文件放在 `models--org--repo/blobs/<sha>`，
 * 而是经一层 `repo/blobs/<sha>` symlink 指向 `hub/blobs/<xx>/<hash>` 的普通文件。
 * 这里只把它登记成「自有 hub 缓存内的另一个受信根」——是否真的存在由校验阶段按目录判断。
 */
export function hfSharedBlobsDir(hfHome: string): string {
	return joinPath(hfHubDir(hfHome), "blobs");
}

/**
 * 自有 HF 缓存的受信根策略：repo 目录 + 共享 blobs 目录都在自有 `hub/` 缓存内。
 * 直接展开成 `managed-weights/verify.ts` 的 `TrustRootOptions` 形状，调用方无需再拼路径。
 */
export function hfTrustRoots(hfHome: string, repo: string): { trustRoot: string; extraTrustRoots: string[]; trustRootBase: string } {
	return { trustRoot: hfRepoDir(hfHome, repo), extraTrustRoots: [hfSharedBlobsDir(hfHome)], trustRootBase: hfHubDir(hfHome) };
}

/** HF 缓存里某个 revision 的 snapshot 目录（snapshot_download 落盘位置）。 */
export function hfSnapshotDir(hfHome: string, repo: string, revision: string): string {
	return joinPath(hfRepoDir(hfHome, repo), "snapshots", revision);
}

function joinPath(...parts: string[]): string {
	// 避免在此模块引入 node:path（保持可被浏览器/脚本复用）；仅拼接，调用方给绝对 hfHome。
	return parts.join("/").replace(/\/{2,}/g, "/");
}
