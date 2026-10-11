/**
 * cloudflared 二进制：找不到时按 third-party.json 固定的版本从 GitHub 官方发布下载到 数据目录/bin，并校验 SHA256。
 * 安装包会内置；源码运行（npm run start）时首次开启远程访问自动下载。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

type Asset = { file: string; sha256: string };
type Manifest = { version: string; repo: string; assets: Record<string, Asset> };

export function cloudflaredManifest(): Manifest {
	const j = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "third-party.json"), "utf8")) as { components: (Manifest & { name: string })[] };
	const c = j.components.find((x) => x.name === "cloudflared");
	if (!c) throw new Error("third-party.json 缺少 cloudflared");
	return c;
}

export const platformKey = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`;
const exeName = () => (process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
export const managedPath = () => join(config.dataDir, "bin", exeName());

export function findCloudflared(): string | null {
	const exe = exeName();
	const candidates = [config.cloudflared, managedPath(), join(import.meta.dirname, "..", "bin", exe)].filter(Boolean) as string[];
	for (const c of candidates) if (existsSync(c)) return c;
	for (const dir of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) if (dir && existsSync(join(dir, exe))) return join(dir, exe);
	return null;
}

let downloading: Promise<string> | null = null;
/** 返回可用的 cloudflared 路径；没有就下载（并发调用共用一次下载）。 */
export function ensureCloudflared(onProgress?: (msg: string) => void): Promise<string> {
	const found = findCloudflared();
	if (found) return Promise.resolve(found);
	downloading ??= download(onProgress).finally(() => (downloading = null));
	return downloading;
}

async function download(onProgress?: (msg: string) => void): Promise<string> {
	const m = cloudflaredManifest();
	const key = platformKey();
	const asset = m.assets[key];
	if (!asset) throw new Error(`没有适用于 ${key} 的 cloudflared，请手动安装后放到 PATH`);
	const url = `https://github.com/${m.repo}/releases/download/${m.version}/${asset.file}`;
	onProgress?.(`正在下载 cloudflared ${m.version}…`);
	const res = await fetch(url, { signal: AbortSignal.timeout(180_000), redirect: "follow" });
	if (!res.ok) throw new Error(`下载 cloudflared 失败：HTTP ${res.status}`);
	const buf = Buffer.from(await res.arrayBuffer());
	const got = createHash("sha256").update(buf).digest("hex");
	if (got !== asset.sha256) throw new Error(`cloudflared 校验失败（SHA256 不匹配），已丢弃`);
	const dir = join(config.dataDir, "bin");
	mkdirSync(dir, { recursive: true });
	const target = managedPath();
	const tmp = `${target}.download`;
	if (asset.file.endsWith(".tgz")) {
		const tgz = join(dir, asset.file);
		writeFileSync(tgz, buf);
		const out = join(dir, "extract");
		rmSync(out, { recursive: true, force: true });
		mkdirSync(out);
		execFileSync("tar", ["xzf", tgz, "-C", out, "cloudflared"]);
		renameSync(join(out, "cloudflared"), tmp);
		rmSync(out, { recursive: true, force: true });
		rmSync(tgz, { force: true });
	} else writeFileSync(tmp, buf);
	if (process.platform !== "win32") chmodSync(tmp, 0o755);
	renameSync(tmp, target);
	onProgress?.(`cloudflared ${m.version} 已就绪`);
	return target;
}
