/**
 * Pi 扩展包（Pi packages：npm / git / 本地目录，里面可以有扩展、技能、提示模板）。
 * 用 Pi 自己的 DefaultPackageManager 安装，但装到我们自己的目录（数据目录/pi-packages），
 * 不读写用户的 ~/.pi/agent/settings.json，也不用用户全局的 npm 缓存/配置。
 * 会话加载时把已启用包的安装目录作为 additionalExtensionPaths 交给 Pi（按包目录走 Pi 的正常发现规则）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { bus } from "./bus.ts";
import { config } from "./config.ts";
import { db, getSetting, now, setSetting, uid } from "./db.ts";
import { registerDownload, trackDownload, unregisterDownload, watchDir } from "./downloads.ts";

export interface PiPackageRow {
	id: string;
	source: string;
	enabled: number;
	agents: string | null;
	status: "installing" | "installed" | "error";
	installed_path: string | null;
	resources: string | null;
	error: string | null;
	created_at: number;
	updated_at: number;
}
export const packagesHome = () => join(config.dataDir, "pi-packages");
export const packagesVersion = () => getSetting("piPackagesVersion", 0);
function changed() {
	setSetting("piPackagesVersion", packagesVersion() + 1);
	bus.emit({ type: "packages.changed" });
}
export const listPackages = () => db.prepare("SELECT * FROM pi_packages ORDER BY created_at").all() as unknown as PiPackageRow[];
export const getPackage = (id: string) => db.prepare("SELECT * FROM pi_packages WHERE id = ?").get(id) as PiPackageRow | undefined;

/** 规范化来源：npm:xxx / git:xxx / https://… / 本地绝对路径 */
export function normalizeSource(src: string) {
	const s = src.trim();
	if (!s) throw new Error("请填写来源");
	if (/^(npm|git):/.test(s) || /^https?:\/\//.test(s)) return s;
	if (isAbsolute(s)) return resolve(s);
	if (/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[^\s]+)?$/i.test(s)) return `npm:${s}`;
	throw new Error("来源格式：npm:包名[@版本]、git:github.com/用户/仓库[@版本]、https://… 或本机绝对路径");
}

function manager() {
	const home = packagesHome();
	mkdirSync(home, { recursive: true });
	const npmrc = join(home, "npmrc");
	const registry = getSetting<string | null>("npmRegistry", null);
	writeFileSync(npmrc, registry ? `registry=${registry}\n` : "");
	return {
		pm: new DefaultPackageManager({ cwd: home, agentDir: home, settingsManager: SettingsManager.inMemory(process.env.PIA_NPM ? { npmCommand: process.env.PIA_NPM.split(" ") } : {}) }),
		// 只在安装期间生效：npm 缓存与配置都指向我们自己的目录
		env: { npm_config_cache: join(home, "npm-cache"), npm_config_userconfig: npmrc, npm_config_globalconfig: npmrc, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" },
	};
}
let queue: Promise<unknown> = Promise.resolve();
async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
	const run = async () => {
		const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
		Object.assign(process.env, env);
		try {
			return await fn();
		} finally {
			for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v);
		}
	};
	const p = queue.then(run, run);
	queue = p.catch(() => {});
	return p;
}

/** 包里有什么：读 package.json 的 pi 字段，或约定目录 */
function inspect(dir: string) {
	const out = { name: "", version: "", description: "", extensions: 0, skills: 0, prompts: 0 };
	try {
		const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		Object.assign(out, { name: pj.name ?? "", version: pj.version ?? "", description: pj.description ?? "" });
		if (pj.pi) for (const k of ["extensions", "skills", "prompts"] as const) out[k] = Array.isArray(pj.pi[k]) ? pj.pi[k].length : 0;
	} catch {
		/* 没有 package.json 也可以是包 */
	}
	for (const k of ["extensions", "skills", "prompts"] as const) if (!out[k] && existsSync(join(dir, k))) out[k] = 1;
	return out;
}

export async function addPackage(source: string, agents: string[] | null = null) {
	const src = normalizeSource(source);
	if (db.prepare("SELECT 1 FROM pi_packages WHERE source = ?").get(src)) throw new Error("这个包已经添加过了");
	const id = uid("pkg");
	const t = now();
	db.prepare("INSERT INTO pi_packages(id, source, enabled, agents, status, created_at, updated_at) VALUES(?,?,?,?, 'installing', ?, ?)").run(id, src, 1, agents ? JSON.stringify(agents) : null, t, t);
	bus.emit({ type: "packages.changed" });
	void install(id);
	return getPackage(id)!;
}

/** 统一下载状态：每个 npm / git 扩展包一条 */
function regPkg(row: PiPackageRow) {
	if (isAbsolute(row.source)) return;
	registerDownload({ id: `pi-package:${row.id}`, name: `扩展包 ${row.source.replace(/^(npm|git):/, "")}`, group: "Pi 扩展包", installed: () => getPackage(row.id)?.status === "installed", start: () => install(row.id) });
}
try {
	for (const r of listPackages()) regPkg(r);
} catch {
	/* 首次启动表还没建 */
}

export async function install(id: string) {
	const row = getPackage(id);
	if (!row) return;
	db.prepare("UPDATE pi_packages SET status = 'installing', error = NULL, updated_at = ? WHERE id = ?").run(now(), id);
	try {
		let path: string | undefined;
		if (isAbsolute(row.source)) {
			if (!existsSync(row.source)) throw new Error("本机路径不存在");
			path = row.source;
		} else {
			const { pm, env } = manager();
			regPkg(row);
			await trackDownload(`pi-package:${id}`, (prog) => watchDir([packagesHome()], prog, null, () => withEnv(env, () => pm.install(row.source))));
			path = pm.getInstalledPath(row.source, "user");
		}
		if (!path || !existsSync(path)) throw new Error("安装完成但找不到安装目录");
		db.prepare("UPDATE pi_packages SET status = 'installed', installed_path = ?, resources = ?, updated_at = ? WHERE id = ?").run(path, JSON.stringify(inspect(path)), now(), id);
	} catch (e) {
		db.prepare("UPDATE pi_packages SET status = 'error', error = ?, updated_at = ? WHERE id = ?").run((e instanceof Error ? e.message : String(e)).slice(0, 2000), now(), id);
	}
	changed();
}

export async function removePackage(id: string) {
	const row = getPackage(id);
	if (!row) return false;
	if (!isAbsolute(row.source) && row.status === "installed") {
		const { pm, env } = manager();
		await withEnv(env, () => pm.remove(row.source)).catch(() => {});
	}
	db.prepare("DELETE FROM pi_packages WHERE id = ?").run(id);
	unregisterDownload(`pi-package:${id}`);
	changed();
	return true;
}
export function setPackageEnabled(id: string, enabled: boolean, agents?: string[] | null) {
	db.prepare("UPDATE pi_packages SET enabled = ?, agents = CASE WHEN ? THEN ? ELSE agents END, updated_at = ? WHERE id = ?").run(Number(enabled), Number(agents !== undefined), agents ? JSON.stringify(agents) : null, now(), id);
	changed();
}

/** 某个助理的会话要加载的包目录 */
export function packagePathsFor(agentId: string) {
	return listPackages()
		.filter((p) => p.enabled && p.status === "installed" && p.installed_path && existsSync(p.installed_path))
		.filter((p) => (p.agents ? (JSON.parse(p.agents) as string[]).includes(agentId) : true))
		.map((p) => p.installed_path!);
}
