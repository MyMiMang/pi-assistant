/**
 * MCP 服务器（我们自己的配置，不读用户的 ~/.pi/agent/mcp.json）。
 * 存在 SQLite（配置整体加密，因为 env / headers 里常有 token），按助理启用；
 * 会话里通过 pi-adapter 交给 Pi 内置的 MCP 扩展（createMcpExtension 的 loadConfig）连接，
 * 工具调用照常经过我们的审批闸门（按 MCP 工具的 readOnly/destructive 注解判断）。
 * “测试连接 / 工具列表”用 Pi 的 @earendil-works/pi-mcp 客户端直接连一次。
 */
import { McpClient, StdioTransport, StreamableHttpTransport, type Tool } from "@earendil-works/pi-mcp";
import { bus } from "./bus.ts";
import { db, getSetting, now, setSetting, uid } from "./db.ts";
import { resolveMcpCommand } from "./mcp-install.ts";
import { openJson, sealJson } from "./secrets.ts";

export type McpExposure = "direct" | "deferred" | "codemode" | "hidden";
export interface McpConfig {
	/** stdio：本机命令；http：Streamable HTTP 地址 */
	type: "stdio" | "http";
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	oauth?: { clientId?: string; clientSecret?: string; callbackPort?: number; scope?: string };
	description?: string;
	exposure?: McpExposure;
	timeout?: number;
}
export interface McpServerRow {
	id: string;
	name: string;
	config: string;
	enabled: number;
	agents: string | null;
	status: string | null;
	tools: string | null;
	error: string | null;
	checked_at: number | null;
	created_at: number;
	updated_at: number;
}
export const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

export const mcpVersion = () => getSetting("mcpVersion", 0);
function changed() {
	setSetting("mcpVersion", mcpVersion() + 1);
	bus.emit({ type: "mcp.changed" } as never);
}

const SECRET_KEY = /token|key|secret|password|authorization|cookie/i;
/** 给界面看的配置：敏感的 env / header 值打码 */
export function redact(c: McpConfig): McpConfig {
	const mask = (o?: Record<string, string>) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, SECRET_KEY.test(k) && !/^\$\{.+\}$/.test(v) ? "••••••" : v])) : undefined);
	return { ...c, env: mask(c.env), headers: mask(c.headers), oauth: c.oauth ? { ...c.oauth, clientSecret: c.oauth.clientSecret ? "••••••" : undefined } : undefined };
}
export const configOf = (r: McpServerRow) => openJson<McpConfig>(r.config);
export const agentsOf = (r: { agents: string | null }) => (r.agents ? (JSON.parse(r.agents) as string[]) : null);

export function validateMcp(name: string, c: McpConfig) {
	if (!MCP_NAME_RE.test(name)) throw new Error("名称只能用字母、数字、_ 和 -（最长 40）");
	if (c.type === "stdio") {
		if (!c.command?.trim()) throw new Error("请填写启动命令，例如 npx");
		if (/\s/.test(c.command.trim())) throw new Error("命令只填可执行文件（如 npx），参数写到“参数”里");
	} else if (c.type === "http") {
		if (!c.url || !/^https?:\/\//.test(c.url)) throw new Error("请填写 http(s):// 开头的 MCP 地址");
		if (/\/sse\/?$/.test(c.url)) throw new Error("不支持旧版 SSE 传输；这类服务通常在 /mcp 提供 Streamable HTTP");
	} else throw new Error("类型只能是 stdio 或 http");
}

export const listMcp = () => db.prepare("SELECT * FROM mcp_servers ORDER BY created_at").all() as unknown as McpServerRow[];
export const getMcp = (id: string) => db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id) as McpServerRow | undefined;

/** 编辑时界面传回打码值 "••••••" 表示保持原值 */
function mergeSecrets(next: McpConfig, prev?: McpConfig): McpConfig {
	if (!prev) return next;
	const keep = (n?: Record<string, string>, p?: Record<string, string>) => (n ? Object.fromEntries(Object.entries(n).map(([k, v]) => [k, v === "••••••" ? (p?.[k] ?? "") : v])) : n);
	return { ...next, env: keep(next.env, prev.env), headers: keep(next.headers, prev.headers), oauth: next.oauth ? { ...next.oauth, clientSecret: next.oauth.clientSecret === "••••••" ? prev.oauth?.clientSecret : next.oauth.clientSecret } : undefined };
}

export function saveMcp(input: { id?: string; name: string; config: McpConfig; enabled?: boolean; agents?: string[] | null }) {
	const prev = input.id ? getMcp(input.id) : undefined;
	const config = mergeSecrets(input.config, prev ? configOf(prev) : undefined);
	validateMcp(input.name, config);
	const clash = db.prepare("SELECT id FROM mcp_servers WHERE replace(lower(name),'-','_') = replace(lower(?),'-','_') AND id != ?").get(input.name, input.id ?? "");
	if (clash) throw new Error("已经有同名的 MCP 服务");
	const t = now();
	const agents = input.agents === undefined ? (prev?.agents ?? null) : input.agents ? JSON.stringify(input.agents) : null;
	if (prev)
		db.prepare("UPDATE mcp_servers SET name = ?, config = ?, enabled = ?, agents = ?, updated_at = ?, status = NULL, tools = NULL, error = NULL WHERE id = ?").run(input.name, sealJson(config), input.enabled === undefined ? prev.enabled : Number(input.enabled), agents, t, prev.id);
	else db.prepare("INSERT INTO mcp_servers(id, name, config, enabled, agents, created_at, updated_at) VALUES(?,?,?,?,?,?,?)").run(input.id ?? uid("mcp"), input.name, sealJson(config), Number(input.enabled ?? true), agents, t, t);
	changed();
	return db.prepare("SELECT * FROM mcp_servers WHERE name = ?").get(input.name) as unknown as McpServerRow;
}
export function setMcpEnabled(id: string, enabled: boolean, agents?: string[] | null) {
	db.prepare("UPDATE mcp_servers SET enabled = ?, agents = CASE WHEN ? THEN ? ELSE agents END, updated_at = ? WHERE id = ?").run(Number(enabled), Number(agents !== undefined), agents ? JSON.stringify(agents) : null, now(), id);
	changed();
}
export function deleteMcp(id: string) {
	const ok = db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id).changes > 0;
	if (ok) changed();
	return ok;
}

/** 某个助理会话要连接的 MCP 服务（Pi McpServerConfig 形状） */
export function mcpServersFor(agentId: string) {
	return listMcp()
		.filter((r) => r.enabled && (agentsOf(r)?.includes(agentId) ?? true))
		.map((r) => {
			const c = configOf(r);
			const base = { description: c.description || undefined, exposure: c.exposure ?? "direct", timeout: c.timeout };
			const config =
				c.type === "stdio"
					? { ...base, type: "stdio" as const, ...resolveMcpCommand(c), env: c.env, cwd: c.cwd || undefined }
					: { ...base, type: "http" as const, url: c.url!, headers: c.headers && Object.keys(c.headers).length ? c.headers : undefined, oauth: c.oauth };
			return { name: r.name, config };
		});
}

/** 解析 ${NAME} 环境变量引用（测试连接用；会话里由 Pi 自己解析）。不执行 !command。 */
const expand = (v: string) => v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => process.env[n] ?? "");

/** 连一次：返回工具列表并记录状态 */
export async function testMcp(id: string, opts: { timeoutMs?: number } = {}) {
	const r = getMcp(id);
	if (!r) throw new Error("not_found");
	const c = configOf(r);
	const client = new McpClient({ name: "pi-assistant", version: "1.0.0", requestTimeoutMs: opts.timeoutMs ?? 20_000 });
	let stderr = "";
	const transport =
		c.type === "stdio"
			? new StdioTransport({ ...resolveMcpCommand(c), env: Object.fromEntries(Object.entries(c.env ?? {}).map(([k, v]) => [k, expand(v)])), cwd: c.cwd || undefined, stderr: "pipe", onStderr: (s) => (stderr = (stderr + s).slice(-2000)) })
			: new StreamableHttpTransport({ url: c.url!, headers: Object.fromEntries(Object.entries(c.headers ?? {}).map(([k, v]) => [k, expand(v)])), openGetStream: false });
	const timer = setTimeout(() => void client.close().catch(() => {}), (opts.timeoutMs ?? 20_000) + 2000);
	try {
		await client.connect(transport);
		const tools: Tool[] = client.serverCapabilities?.tools ? await client.listTools() : [];
		const slim = tools.map((t) => ({ name: t.name, description: (t.description ?? "").slice(0, 300), readOnly: !!t.annotations?.readOnlyHint, destructive: !!t.annotations?.destructiveHint }));
		db.prepare("UPDATE mcp_servers SET status = 'ok', tools = ?, error = NULL, checked_at = ? WHERE id = ?").run(JSON.stringify(slim), now(), id);
		return { ok: true as const, server: client.serverInfo, tools: slim };
	} catch (e) {
		let msg = e instanceof Error ? e.message : String(e);
		if (/401|unauthori[sz]ed|auth.*required/i.test(msg)) msg = `需要登录授权（OAuth）。在电脑上让助理使用一次这个服务时会自动打开授权页。原始错误：${msg}`;
		if (/ENOENT/.test(msg)) msg = `找不到命令「${c.command}」。请确认已安装（例如 Node.js 自带 npx，Python 工具需要 uvx）。`;
		if (stderr.trim()) msg += `\n\n服务输出：\n${stderr.trim().slice(-800)}`;
		db.prepare("UPDATE mcp_servers SET status = 'error', error = ?, checked_at = ? WHERE id = ?").run(msg, now(), id);
		return { ok: false as const, error: msg };
	} finally {
		clearTimeout(timer);
		await client.close().catch(() => {});
	}
}
