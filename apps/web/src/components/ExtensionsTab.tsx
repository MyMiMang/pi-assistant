import { AlertTriangle, ChevronDown, ChevronRight, Package, Plug, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { Badge, Button, cx, Help, Input } from "./ui";

type Exposure = "direct" | "deferred" | "codemode" | "hidden";
interface McpConfig {
	type: "stdio" | "http";
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	oauth?: { clientId?: string; clientSecret?: string; callbackPort?: number; scope?: string };
	description?: string;
	exposure?: Exposure;
}
interface McpServer {
	id: string;
	name: string;
	enabled: boolean;
	agents: string[] | null;
	config: McpConfig;
	status: "ok" | "error" | null;
	tools: { name: string; description: string; readOnly: boolean; destructive: boolean }[] | null;
	error: string | null;
	checkedAt: number | null;
}
interface PiPackage {
	id: string;
	source: string;
	enabled: boolean;
	agents: string[] | null;
	status: "installing" | "installed" | "error";
	resources: { name: string; version: string; description: string; extensions: number; skills: number; prompts: number } | null;
	error: string | null;
}

const kv = (o?: Record<string, string>) => Object.entries(o ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");
const parseKv = (s: string, sep = "=") =>
	Object.fromEntries(
		s
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
			.map((l) => {
				const i = l.indexOf(sep);
				return i < 0 ? [l, ""] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
			}),
	);
/** 粗略拆分参数：支持引号 */
const splitArgs = (s: string) => (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((a) => a.replace(/^["']|["']$/g, ""));
const joinArgs = (a?: string[]) => (a ?? []).map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(" ");

const EXPOSURE: [Exposure, string][] = [
	["direct", "直接给模型（工具少时推荐）"],
	["deferred", "按需搜索（工具很多时）"],
	["codemode", "只在脚本里调用"],
];
const PRESETS: { label: string; name: string; cfg: McpConfig }[] = [
	{ label: "文件系统", name: "filesystem", cfg: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] } },
	{ label: "抓取网页", name: "fetch", cfg: { type: "stdio", command: "uvx", args: ["mcp-server-fetch"] } },
	{ label: "远程（HTTP）", name: "remote", cfg: { type: "http", url: "https://" } },
];

function AgentPicker({ value, onChange }: { value: string[] | null; onChange: (v: string[] | null) => void }) {
	const agents = useStore((s) => s.agents);
	return (
		<div className="space-y-1.5 text-sm">
			<label className="flex items-center gap-2">
				<input type="radio" checked={value === null} onChange={() => onChange(null)} /> 所有助理
			</label>
			<label className="flex items-center gap-2">
				<input type="radio" checked={value !== null} onChange={() => onChange(agents.slice(0, 1).map((a) => a.id))} /> 只给这些助理
			</label>
			{value !== null && (
				<div className="flex flex-wrap gap-1.5 pl-6">
					{agents.map((a) => (
						<button key={a.id} type="button" className={cx("pa-chip sm", value.includes(a.id) && "!border-accent !text-accent")} onClick={() => onChange(value.includes(a.id) ? value.filter((x) => x !== a.id) : [...value, a.id])}>
							{a.avatar && a.avatar.length <= 2 ? `${a.avatar} ` : ""}
							{a.name}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

function McpForm({ initial, onDone }: { initial?: McpServer; onDone: () => void }) {
	const [name, setName] = useState(initial?.name ?? "");
	const [cfg, setCfg] = useState<McpConfig>(initial?.config ?? { type: "stdio", command: "npx", args: [] });
	const [args, setArgs] = useState(joinArgs(initial?.config.args));
	const [env, setEnv] = useState(kv(initial?.config.env));
	const [headers, setHeaders] = useState(Object.entries(initial?.config.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n"));
	const [agents, setAgents] = useState<string[] | null>(initial?.agents ?? null);
	const [oauth, setOauth] = useState(!!initial?.config.oauth);
	const [err, setErr] = useState("");
	const [busy, setBusy] = useState(false);
	const save = async () => {
		setErr("");
		setBusy(true);
		const config: McpConfig =
			cfg.type === "stdio"
				? { type: "stdio", command: cfg.command?.trim(), args: splitArgs(args), env: parseKv(env), cwd: cfg.cwd || undefined, description: cfg.description, exposure: cfg.exposure }
				: { type: "http", url: cfg.url?.trim(), headers: parseKv(headers, ":"), oauth: oauth ? (cfg.oauth ?? {}) : undefined, description: cfg.description, exposure: cfg.exposure };
		try {
			await api(initial ? `/api/mcp/${initial.id}` : "/api/mcp", { method: initial ? "PUT" : "POST", json: { name: name.trim(), config, agents } });
			onDone();
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="pa-card space-y-3 !p-4" data-testid="mcp-form">
			{!initial && (
				<div className="flex flex-wrap gap-1.5">
					<span className="text-xs text-mut">常用：</span>
					{PRESETS.map((p) => (
						<button
							key={p.name}
							className="pa-chip sm"
							onClick={() => {
								setName(p.name);
								setCfg(p.cfg);
								setArgs(joinArgs(p.cfg.args));
							}}
						>
							{p.label}
						</button>
					))}
				</div>
			)}
			<div className="grid gap-3 sm:grid-cols-[1fr_auto]">
				<label className="space-y-1">
					<span className="text-xs font-medium text-mut">名称（字母、数字、_、-）</span>
					<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="github" className="font-mono" />
				</label>
				<div className="space-y-1">
					<span className="text-xs font-medium text-mut">类型</span>
					<div className="flex gap-1">
						{(["stdio", "http"] as const).map((t) => (
							<button key={t} className={cx("pa-chip", cfg.type === t && "!bg-hover !text-fg font-medium")} onClick={() => setCfg({ ...cfg, type: t })}>
								{t === "stdio" ? "本机命令" : "远程 HTTP"}
							</button>
						))}
					</div>
				</div>
			</div>
			{cfg.type === "stdio" ? (
				<>
					<div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
						<label className="space-y-1">
							<span className="text-xs font-medium text-mut">命令</span>
							<Input className="font-mono" value={cfg.command ?? ""} onChange={(e) => setCfg({ ...cfg, command: e.target.value })} placeholder="npx" />
						</label>
						<label className="space-y-1">
							<span className="text-xs font-medium text-mut">参数</span>
							<Input className="font-mono" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-github" />
						</label>
					</div>
					<label className="block space-y-1">
						<span className="text-xs font-medium text-mut">环境变量（每行 KEY=VALUE；可写 {"${NAME}"} 引用电脑上的环境变量）</span>
						<textarea className="pa-input !h-20 py-2 w-full font-mono text-[13px]" value={env} onChange={(e) => setEnv(e.target.value)} placeholder="GITHUB_TOKEN=ghp_…" />
					</label>
				</>
			) : (
				<>
					<label className="block space-y-1">
						<span className="text-xs font-medium text-mut">地址（Streamable HTTP，通常以 /mcp 结尾）</span>
						<Input className="font-mono" value={cfg.url ?? ""} onChange={(e) => setCfg({ ...cfg, url: e.target.value })} placeholder="https://mcp.example.com/mcp" />
					</label>
					<label className="block space-y-1">
						<span className="text-xs font-medium text-mut">请求头（每行 名称: 值）</span>
						<textarea className="pa-input !h-16 py-2 w-full font-mono text-[13px]" value={headers} onChange={(e) => setHeaders(e.target.value)} placeholder="Authorization: Bearer …" />
					</label>
					<label className="flex items-start gap-2 text-sm">
						<input type="checkbox" className="mt-1" checked={oauth} onChange={(e) => setOauth(e.target.checked)} />
						<span>
							使用 OAuth 登录
							<span className="block text-xs text-mut">
								可选。<Help>不填请求头时，服务要求登录会自动在这台电脑上打开授权页（需要在电脑上完成）。服务不支持自动注册时，填写预先注册的 Client ID。</Help>
							</span>
						</span>
					</label>
					{oauth && (
						<div className="grid gap-2 pl-6 sm:grid-cols-2">
							<Input placeholder="Client ID（可选）" value={cfg.oauth?.clientId ?? ""} onChange={(e) => setCfg({ ...cfg, oauth: { ...cfg.oauth, clientId: e.target.value || undefined } })} />
							<Input placeholder="Client Secret（可选）" type="password" value={cfg.oauth?.clientSecret ?? ""} onChange={(e) => setCfg({ ...cfg, oauth: { ...cfg.oauth, clientSecret: e.target.value || undefined } })} />
						</div>
					)}
				</>
			)}
			<label className="block space-y-1">
				<span className="text-xs font-medium text-mut">说明（可选：一句话告诉助理这个服务能做什么）</span>
				<Input value={cfg.description ?? ""} onChange={(e) => setCfg({ ...cfg, description: e.target.value })} placeholder="查询和管理 GitHub 仓库、Issue、PR" />
			</label>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-1">
					<span className="text-xs font-medium text-mut">工具给模型的方式</span>
					<select className="pa-input w-full" value={cfg.exposure ?? "direct"} onChange={(e) => setCfg({ ...cfg, exposure: e.target.value as Exposure })}>
						{EXPOSURE.map(([k, v]) => (
							<option key={k} value={k}>
								{v}
							</option>
						))}
					</select>
				</div>
				<div className="space-y-1">
					<span className="text-xs font-medium text-mut">哪些助理可以用</span>
					<AgentPicker value={agents} onChange={setAgents} />
				</div>
			</div>
			{err && <div className="whitespace-pre-wrap text-sm text-red-500">{err}</div>}
			<div className="flex justify-end gap-2">
				<Button variant="ghost" onClick={onDone}>
					取消
				</Button>
				<Button variant="primary" disabled={busy || !name.trim()} onClick={save}>
					{busy ? "保存中…" : "保存并测试连接"}
				</Button>
			</div>
		</div>
	);
}

function McpItem({ s, reload }: { s: McpServer; reload: () => void }) {
	const agents = useStore((st) => st.agents);
	const [open, setOpen] = useState(false);
	const [edit, setEdit] = useState(false);
	const [testing, setTesting] = useState(false);
	if (edit) return <McpForm initial={s} onDone={() => (setEdit(false), reload())} />;
	const target = s.config.type === "stdio" ? `${s.config.command} ${joinArgs(s.config.args)}` : s.config.url;
	return (
		<li className="pa-card !p-3 text-sm" data-testid="mcp-item">
			<div className="flex items-start gap-3">
				<input type="checkbox" className="mt-1" checked={s.enabled} aria-label={`启用 ${s.name}`} onChange={async (e) => (await api(`/api/mcp/${s.id}`, { method: "PATCH", json: { enabled: e.target.checked } }), reload())} />
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-1.5">
						<b className="font-mono">{s.name}</b>
						<Badge>{s.config.type === "stdio" ? "本机命令" : "HTTP"}</Badge>
						{testing ? <Badge tone="accent">连接中…</Badge> : s.status === "ok" ? <Badge tone="green">已连接 · {s.tools?.length ?? 0} 个工具</Badge> : s.status === "error" ? <Badge tone="red">连接失败</Badge> : <Badge>未测试</Badge>}
						<span className="text-xs text-mut">{s.agents ? `仅 ${s.agents.map((id) => agents.find((a) => a.id === id)?.name ?? "?").join("、")}` : "所有助理"}</span>
					</div>
					<div className="mt-0.5 truncate font-mono text-xs text-mut">{target}</div>
					{s.config.description && <div className="mt-0.5 text-xs text-mut">{s.config.description}</div>}
					{s.status === "error" && s.error && <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-red-500/10 p-2 text-xs text-red-600 dark:text-red-400">{s.error}</pre>}
					{s.tools && s.tools.length > 0 && (
						<button className="mt-1 flex items-center gap-1 text-xs text-mut hover:text-fg" onClick={() => setOpen(!open)}>
							{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} 工具列表
						</button>
					)}
					{open && (
						<ul className="mt-1 space-y-0.5 text-xs" data-testid="mcp-tools">
							{s.tools!.map((t) => (
								<li key={t.name} className="flex gap-2">
									<code className="shrink-0 font-mono">{t.name}</code>
									{t.readOnly ? <Badge tone="green">只读·免审批</Badge> : <Badge tone="amber">{t.destructive ? "有副作用·需审批" : "需审批"}</Badge>}
									<span className="truncate text-mut">{t.description}</span>
								</li>
							))}
						</ul>
					)}
				</div>
				<div className="flex shrink-0 gap-0.5">
					<Button
						size="sm"
						variant="ghost"
						aria-label="测试连接"
						onClick={async () => {
							setTesting(true);
							await api(`/api/mcp/${s.id}/test`, { method: "POST" }).catch(() => {});
							setTesting(false);
							reload();
						}}
					>
						<RefreshCw size={13} />
					</Button>
					<Button size="sm" variant="ghost" onClick={() => setEdit(true)}>
						编辑
					</Button>
					<Button size="sm" variant="ghost" aria-label="删除 MCP 服务" onClick={async () => confirm(`删除 MCP 服务「${s.name}」？`) && (await api(`/api/mcp/${s.id}`, { method: "DELETE" }), reload())}>
						<Trash2 size={13} />
					</Button>
				</div>
			</div>
		</li>
	);
}

function PackagesSection() {
	const version = useStore((s) => s.extVersion);
	const agents = useStore((s) => s.agents);
	const [list, setList] = useState<PiPackage[]>([]);
	const [src, setSrc] = useState("");
	const [scope, setScope] = useState<string[] | null>(null);
	const [err, setErr] = useState("");
	const load = () => api<PiPackage[]>("/api/pi-packages").then(setList);
	useEffect(() => {
		void load();
	}, [version]);
	return (
		<section className="space-y-3" data-testid="packages-section">
			<div className="flex items-center gap-2">
				<Package size={16} />
				<h3 className="font-semibold">Pi 扩展包</h3>
			</div>
			<p className="text-xs text-mut">
				给助理加新工具、技能和模板。 <Help>Pi 生态的扩展包（npm / git / 本机目录），可以包含扩展（新工具、新能力）、技能和提示模板。装在本应用自己的目录里，不影响你电脑上自己安装的 Pi。</Help>
			</p>
			<div className="flex items-start gap-2 rounded-xl bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
				<AlertTriangle size={14} className="mt-0.5 shrink-0" />
				只安装你信任的来源。 <Help>扩展包里的代码会以本应用的权限在这台电脑上运行，安装前最好看一下源码。</Help>
			</div>
			<div className="pa-card space-y-2 !p-3">
				<div className="flex gap-2">
					<Input className="flex-1 font-mono" placeholder="npm:@scope/pi-tools@1.0.0 或 git:github.com/user/repo@v1 或本机路径" value={src} onChange={(e) => setSrc(e.target.value)} />
					<Button
						variant="primary"
						disabled={!src.trim()}
						onClick={async () => {
							setErr("");
							try {
								await api("/api/pi-packages", { method: "POST", json: { source: src, agents: scope } });
								setSrc("");
								void load();
							} catch (e) {
								setErr(e instanceof Error ? e.message : String(e));
							}
						}}
					>
						<Plus size={14} /> 安装
					</Button>
				</div>
				<AgentPicker value={scope} onChange={setScope} />
				{err && <div className="text-sm text-red-500">{err}</div>}
			</div>
			<ul className="space-y-2">
				{list.map((p) => (
					<li key={p.id} className="pa-card flex items-start gap-3 !p-3 text-sm" data-testid="package-item">
						<input type="checkbox" className="mt-1" checked={p.enabled} aria-label="启用" onChange={async (e) => (await api(`/api/pi-packages/${p.id}`, { method: "PATCH", json: { enabled: e.target.checked } }), load())} />
						<div className="min-w-0 flex-1">
							<div className="flex flex-wrap items-center gap-1.5">
								<b className="font-mono">{p.resources?.name || p.source}</b>
								{p.resources?.version && <span className="text-xs text-mut">v{p.resources.version}</span>}
								{p.status === "installing" ? <Badge tone="accent">安装中…</Badge> : p.status === "installed" ? <Badge tone="green">已安装</Badge> : <Badge tone="red">安装失败</Badge>}
								<span className="text-xs text-mut">{p.agents ? `仅 ${p.agents.map((id) => agents.find((a) => a.id === id)?.name ?? "?").join("、")}` : "所有助理"}</span>
							</div>
							<div className="truncate font-mono text-xs text-mut">{p.source}</div>
							{p.resources && (
								<div className="mt-0.5 text-xs text-mut">
									{p.resources.description} {p.resources.extensions ? `· 扩展 ${p.resources.extensions}` : ""} {p.resources.skills ? `· 技能 ${p.resources.skills}` : ""} {p.resources.prompts ? `· 提示模板 ${p.resources.prompts}` : ""}
								</div>
							)}
							{p.error && <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap text-xs text-red-500">{p.error}</pre>}
						</div>
						{p.status === "error" && (
							<Button size="sm" variant="ghost" onClick={() => api(`/api/pi-packages/${p.id}/reinstall`, { method: "POST" }).then(load)}>
								重试
							</Button>
						)}
						<Button size="sm" variant="ghost" aria-label="卸载扩展包" onClick={async () => confirm(`卸载「${p.resources?.name || p.source}」？`) && (await api(`/api/pi-packages/${p.id}`, { method: "DELETE" }), load())}>
							<Trash2 size={13} />
						</Button>
					</li>
				))}
			</ul>
		</section>
	);
}

/** 设置 › 扩展：MCP 服务 + Pi 扩展包 */
export function ExtensionsTab() {
	const version = useStore((s) => s.extVersion);
	const isLocal = useStore((s) => s.system?.local ?? true);
	const [list, setList] = useState<McpServer[]>([]);
	const [adding, setAdding] = useState(false);
	const load = () => api<McpServer[]>("/api/mcp").then(setList);
	useEffect(() => {
		void load();
	}, [version]);
	return (
		<div className="space-y-8" data-testid="extensions-tab">
			{!isLocal && <div className="rounded-xl bg-hover p-3 text-sm">添加和修改扩展只能在电脑上进行，手机上只能查看。</div>}
			<section className="space-y-3">
				<div className="flex items-center gap-2">
					<Plug size={16} />
					<h3 className="font-semibold">MCP 服务</h3>
					<Help>通过 MCP（Model Context Protocol）给助理接入外部工具：GitHub、数据库、地图、公司内部系统……本机命令型服务在这台电脑上运行，npx / uvx 的包会预先下载到本机（下方可看进度）；远程服务支持请求头或 OAuth 登录。只读工具直接用，其他工具每次调用前都会先请你批准。</Help>
					<span className="flex-1" />
					{!adding && (
						<Button size="sm" variant="outline" onClick={() => setAdding(true)}>
							<Plus size={14} /> 添加
						</Button>
					)}
				</div>
				<p className="text-xs text-mut">给助理接入外部工具。</p>
				{adding && <McpForm onDone={() => (setAdding(false), load())} />}
				{list.length === 0 && !adding && <div className="py-4 text-center text-sm text-mut">还没有 MCP 服务</div>}
				<ul className="space-y-2">
					{list.map((s) => (
						<McpItem key={s.id} s={s} reload={load} />
					))}
				</ul>
			</section>
			<PackagesSection />
		</div>
	);
}
