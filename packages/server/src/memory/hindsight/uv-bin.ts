/**
 * 我们自己的 uv：按 third-party.json 固定版本下载到 数据目录/bin，SHA256 校验。
 * 先从 GitHub 发布下载；不通时从 PyPI（或国内镜像）下载同版本 wheel（同样校验固定的 SHA256）。
 * 从不使用 PATH 上用户自己装的 uv。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../config.ts";
import { readZip } from "./zip.ts";

type Asset = { file: string; sha256: string; wheel: string; wheelSha256: string };
type Manifest = { version: string; repo: string; assets: Record<string, Asset> };

export function uvManifest(): Manifest {
	const j = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "..", "third-party.json"), "utf8")) as { components: (Manifest & { name: string })[] };
	const c = j.components.find((x) => x.name === "uv");
	if (!c) throw new Error("third-party.json 缺少 uv");
	return c;
}
const exe = () => (process.platform === "win32" ? "uv.exe" : "uv");
export const uvBinDir = () => join(config.dataDir, "bin");
export const uvPath = () => join(uvBinDir(), exe());
/** 安装包内置的 uv（打包时放在 server/bin） */
const bundled = () => join(import.meta.dirname, "..", "..", "..", "bin", exe());

function version(path: string) {
	try {
		return execFileSync(path, ["--version"], { encoding: "utf8", timeout: 10_000, env: { PATH: "" } }).trim();
	} catch {
		return "";
	}
}

/** 只认我们自己的两个位置，且版本必须与清单一致 */
export function findUv(): string | null {
	const want = uvManifest().version;
	for (const p of [bundled(), uvPath()]) if (existsSync(p) && version(p).includes(want)) return p;
	return null;
}

let pending: Promise<string> | null = null;
export function ensureUv(opts: { pypiIndex?: string; onProgress?: (m: string) => void } = {}): Promise<string> {
	const f = findUv();
	if (f) return Promise.resolve(f);
	pending ??= download(opts).finally(() => (pending = null));
	return pending;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function get(url: string, timeoutMs = 120_000) {
	const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	return Buffer.from(await r.arrayBuffer());
}

/** 从 PEP 503 简单索引页找 wheel 的下载地址（镜像也遵循同一格式） */
async function wheelUrl(index: string, file: string) {
	const base = index.replace(/\/+$/, "");
	const page = (await get(`${base}/uv/`, 30_000)).toString("utf8");
	const m = page.match(new RegExp(`href="([^"]*${file.replace(/[.+]/g, "\\$&")}[^"]*)"`));
	if (!m) throw new Error(`索引里没有 ${file}`);
	return new URL(m[1].replace(/&amp;/g, "&"), `${base}/uv/`).toString();
}

async function download(opts: { pypiIndex?: string; onProgress?: (m: string) => void }): Promise<string> {
	const m = uvManifest();
	const key = `${process.platform}-${process.arch}`;
	const a = m.assets[key];
	if (!a) throw new Error(`没有适用于 ${key} 的 uv`);
	mkdirSync(uvBinDir(), { recursive: true });
	const target = uvPath();
	const tmp = `${target}.download`;
	const errors: string[] = [];
	// 1) GitHub 发布
	try {
		opts.onProgress?.(`正在下载 uv ${m.version}（GitHub）…`);
		const buf = await get(`https://github.com/${m.repo}/releases/download/${m.version}/${a.file}`);
		if (sha(buf) !== a.sha256) throw new Error("SHA256 不匹配");
		if (a.file.endsWith(".zip")) {
			const e = readZip(buf).find((x) => x.name.endsWith(exe()));
			if (!e) throw new Error("压缩包里没有 uv");
			writeFileSync(tmp, e.data());
		} else {
			const dir = join(uvBinDir(), "uv-extract");
			rmSync(dir, { recursive: true, force: true });
			mkdirSync(dir);
			const tgz = join(dir, a.file);
			writeFileSync(tgz, buf);
			execFileSync("tar", ["xzf", tgz, "-C", dir]);
			const inner = a.file.replace(/\.tar\.gz$/, "");
			renameSync(join(dir, inner, exe()), tmp);
			rmSync(dir, { recursive: true, force: true });
		}
	} catch (e) {
		errors.push(`GitHub：${e instanceof Error ? e.message : e}`);
		// 2) PyPI wheel（官方或镜像）
		const indexes = [...new Set([opts.pypiIndex, "https://pypi.org/simple", "https://pypi.tuna.tsinghua.edu.cn/simple", "https://mirrors.aliyun.com/pypi/simple"].filter(Boolean) as string[])];
		let ok = false;
		for (const idx of indexes) {
			try {
				opts.onProgress?.(`正在下载 uv ${m.version}（${new URL(idx).host}）…`);
				const buf = await get(await wheelUrl(idx, a.wheel));
				if (sha(buf) !== a.wheelSha256) throw new Error("SHA256 不匹配");
				const e2 = readZip(buf).find((x) => /\.data\/scripts\/uv(\.exe)?$/.test(x.name));
				if (!e2) throw new Error("wheel 里没有 uv");
				writeFileSync(tmp, e2.data());
				ok = true;
				break;
			} catch (err) {
				errors.push(`${new URL(idx).host}：${err instanceof Error ? err.message : err}`);
			}
		}
		if (!ok) throw new Error(`下载 uv 失败（${errors.join("；")}）`);
	}
	if (process.platform !== "win32") chmodSync(tmp, 0o755);
	renameSync(tmp, target);
	opts.onProgress?.(`uv ${m.version} 已就绪`);
	return target;
}
