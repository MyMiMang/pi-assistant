// 把发布文件作为 OCI 制品推到公开的 GHCR 包，或匿名拉下来（仓库私有，GitHub Release 资产不能匿名下载；
// 公开 GHCR 包可以匿名拉，最终用户的所有下载都走这里）。不依赖 oras，直接用 OCI Distribution API。
//
//   推送：GHCR_TOKEN=<有 write:packages 的令牌，默认取 `gh auth token`> node scripts/ghcr.mjs push <tag> <文件> [--type <artifactType>]
//          一个 tag = 一个文件（manifest 一层，层的 digest = 文件 SHA256，标题注解 = 文件名）
//   查询：node scripts/ghcr.mjs resolve <tag>     → 打印 "sha256:… 大小 文件名"（匿名）
//   拉取：node scripts/ghcr.mjs pull <tag> <输出>  （匿名，校验 SHA256）
// 仓库：GHCR_REPO（默认 mymimang/pi-assistant-desktop，这个包已经公开）
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

export const REPO = process.env.GHCR_REPO ?? "mymimang/pi-assistant-desktop";
export const REGISTRY = process.env.GHCR_HOST ?? "ghcr.io";
const MT = "application/vnd.oci.image.manifest.v1+json";
const EMPTY = { mediaType: "application/vnd.oci.empty.v1+json", digest: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a", size: 2, data: "e30=" };

export async function token(push = false) {
	if (PLAIN) return "";
	const scope = `repository:${REPO}:${push ? "pull,push" : "pull"}`;
	const headers = {};
	if (push) {
		const pat = process.env.GHCR_TOKEN ?? execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
		const user = process.env.GHCR_USER ?? "token";
		headers.Authorization = `Basic ${Buffer.from(`${user}:${pat}`).toString("base64")}`;
	}
	const r = await fetch(`https://${REGISTRY}/token?scope=${encodeURIComponent(scope)}&service=${REGISTRY}`, { headers });
	if (!r.ok) throw new Error(`取 ${push ? "推送" : "匿名"}令牌失败：HTTP ${r.status}${push ? "（令牌需要 write:packages：gh auth refresh -s write:packages）" : ""}`);
	return (await r.json()).token;
}
// 测试用：GHCR_PLAIN=1 时对本地 registry:2 走 http、不取令牌
const PLAIN = process.env.GHCR_PLAIN === "1";
const v2 = (p) => `${PLAIN ? "http" : "https"}://${REGISTRY}/v2/${REPO}/${p}`;

export async function resolve(tag, tok) {
	tok ??= await token();
	const r = await fetch(v2(`manifests/${tag}`), { headers: { Authorization: `Bearer ${tok}`, Accept: MT } });
	if (!r.ok) throw new Error(`找不到 ${REPO}:${tag}（HTTP ${r.status}）`);
	const m = await r.json();
	const l = m.layers?.[0];
	if (!l) throw new Error(`${tag} 不是单文件制品`);
	return { digest: l.digest, size: l.size, name: l.annotations?.["org.opencontainers.image.title"] ?? tag, blobUrl: v2(`blobs/${l.digest}`) };
}

async function putBlob(buf, digest, tok) {
	const auth = { Authorization: `Bearer ${tok}` };
	if ((await fetch(v2(`blobs/${digest}`), { method: "HEAD", headers: auth })).ok) return;
	const s = await fetch(v2("blobs/uploads/"), { method: "POST", headers: auth });
	if (s.status !== 202) throw new Error(`开始上传失败：HTTP ${s.status} ${await s.text()}`);
	const loc = new URL(s.headers.get("location"), `${PLAIN ? "http" : "https"}://${REGISTRY}`);
	loc.searchParams.set("digest", digest);
	const p = await fetch(loc, { method: "PUT", headers: { ...auth, "Content-Type": "application/octet-stream", "Content-Length": String(buf.length) }, body: buf });
	if (p.status !== 201) throw new Error(`上传失败：HTTP ${p.status} ${await p.text()}`);
}

export async function push(tag, file, type = "application/vnd.pi-assistant.file.v1") {
	const tok = await token(true);
	const buf = readFileSync(file);
	const digest = `sha256:${createHash("sha256").update(buf).digest("hex")}`;
	await putBlob(buf, digest, tok);
	await putBlob(Buffer.from("{}"), EMPTY.digest, tok);
	const manifest = {
		schemaVersion: 2, mediaType: MT, artifactType: type,
		config: { mediaType: EMPTY.mediaType, digest: EMPTY.digest, size: 2 },
		layers: [{ mediaType: "application/octet-stream", digest, size: buf.length, annotations: { "org.opencontainers.image.title": basename(file) } }],
		annotations: { "org.opencontainers.image.source": "https://github.com/MyMiMang/pi-assistant", "org.opencontainers.image.created": new Date().toISOString() },
	};
	const r = await fetch(v2(`manifests/${tag}`), { method: "PUT", headers: { Authorization: `Bearer ${tok}`, "Content-Type": MT }, body: JSON.stringify(manifest) });
	if (r.status !== 201) throw new Error(`写入 ${tag} 失败：HTTP ${r.status} ${await r.text()}`);
	console.log(`${REGISTRY}/${REPO}:${tag} → ${basename(file)} ${digest} ${buf.length}`);
	return { digest, size: buf.length, blobUrl: v2(`blobs/${digest}`) };
}

export async function pull(tag, out) {
	const tok = await token();
	const a = await resolve(tag, tok);
	const r = await fetch(a.blobUrl, { headers: { Authorization: `Bearer ${tok}` } });
	if (!r.ok) throw new Error(`下载失败：HTTP ${r.status}`);
	const buf = Buffer.from(await r.arrayBuffer());
	const got = `sha256:${createHash("sha256").update(buf).digest("hex")}`;
	if (got !== a.digest) throw new Error(`校验失败：${got} ≠ ${a.digest}`);
	writeFileSync(out, buf);
	console.log(`${out} ← ${tag}（${buf.length} 字节，${got}）`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const [cmd, a, b, ...rest] = process.argv.slice(2);
	const ti = rest.indexOf("--type");
	try {
		if (cmd === "push" && a && b) await push(a, b, ti >= 0 ? rest[ti + 1] : undefined);
		else if (cmd === "resolve" && a) { const r = await resolve(a); console.log(`${r.digest} ${r.size} ${r.name}`); }
		else if (cmd === "pull" && a && b) await pull(a, b);
		else { console.error("用法：node scripts/ghcr.mjs push <tag> <文件> | resolve <tag> | pull <tag> <输出>"); process.exit(2); }
	} catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }
}
