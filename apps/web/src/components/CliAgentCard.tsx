/**
 * 设置 › 模型服务里的「本机命令行模型」卡片（Claude Code / Codex / Antigravity / OpenCode 共用；方案 docs/design/cli-models.md §4.5、§5.2、§5b，docs/design/acp-cli-models.md）。
 * 旧渠道只检测本机；原生 ACP 渠道使用 Pi 私有安装，提供安装、官方登录、取消和手动更新。
 * 检测到可用后服务端就地注册模型渠道（不用重启），模型出现在所有模型选择里。
 * 加新的一家：在 `KINDS` 里加一项文案，服务端接口按渠道名 `/api/models/<kind>` 对应。
 */
import type { NativeCliStatus } from "@pi-assistant/shared";
import { CheckCircle2, Download, LogIn, Plus, RefreshCw, Terminal, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { Badge, Button, Fold, Help, Input } from "./ui";

interface CliInfo extends NativeCliStatus {
	/** Codex：`~/.codex/AGENTS.md` 存在（只检查文件在不在） */
	globalAgentsMd?: boolean;
}

/** `opencode-cli`：不叫 `opencode`，Pi 自带一个同名的 OpenCode Zen 密钥渠道 */
export type CliKind = "claude-code" | "codex" | "antigravity" | "opencode-cli" | "gemini-cli" | "codebuddy-cli";
/** 模型服务页里要显示的本机命令行渠道（也用来把它们从普通服务列表里去掉） */
export const CLI_KINDS: CliKind[] = ["claude-code", "codex", "antigravity", "opencode-cli", "gemini-cli", "codebuddy-cli"];

/** 每家的文案：命令名、登录命令、一句话说明、「?」说明、已注册后显示的模型 */
const NATIVE_HELP = <>工具会在助理工作文件夹内使用自己的读写文件和执行命令能力，也能调用 Pi 工具。部分读取不会逐项请求批准；工具实际发来的批准请求按助理的权限档位处理，完全权限直接允许一次，其他档位由你逐项批准。配置目录独立，但 Mac 钥匙串中的登录可能共用。工具使用自身能力执行时，你的插话会在这轮结束后送达。</>;

const KINDS: Record<CliKind, { title: string; command: string; login: string; tone: string; summary: string; models: string; help: ReactNode; loginOptional?: string }> = {
	"gemini-cli": {
		title: "Gemini CLI", command: "Pi 专用 Gemini CLI", login: "", tone: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
		summary: "用它自己的读写和命令能力在助理的工作文件夹里干活，也能用 Pi 的工具；Pi 单独装一份，和你电脑上的设置、登录完全分开。", models: "模型：工具默认模型", help: NATIVE_HELP,
	},
	"codebuddy-cli": {
		title: "CodeBuddy", command: "Pi 专用 CodeBuddy", login: "", tone: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
		summary: "用它自己的读写和命令能力在助理的工作文件夹里干活，也能用 Pi 的工具；Pi 单独装一份，和你电脑上的设置、登录完全分开。", models: "模型：工具默认模型", help: NATIVE_HELP,
	},
	"claude-code": {
		title: "Claude Code",
		command: "claude",
		login: "claude auth login",
		tone: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
		summary: "用 Claude Code 当模型，工具由 Pi 执行；Pi 单独装一份，和你电脑上的设置、登录完全分开。",
		models: "模型：/model 里的别名 + 内置的更多版本（Opus 4.8、Sonnet 5.5 等）+ 你自定义的",
		help: (
			<>
				设置、规则与历史存放在 Pi 专用目录，不读取你自己的 Claude Code 配置。Mac 钥匙串是否共用尚未实测；公司强制设置不在隔离范围内。
				<br />
				Claude Code 的会话记录保存在 Pi 专用目录。
				<br />
				用量只显示 token 数，不显示钱（费用走你的 Claude 订阅或账户）。
			</>
		),
	},
	codex: {
		title: "Codex",
		command: "codex",
		login: "codex login",
		tone: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
		summary: "用 Codex（ChatGPT 账号）当模型，工具由 Pi 执行；Pi 单独装一份，和你电脑上的设置、登录完全分开。",
		models: "模型：Codex · GPT 系列（以 Codex 自己的列表为准）",
		help: (
			<>
				只当「大脑」用：Codex 自带的执行命令、改文件、联网搜索、插件和你配置的 MCP 都会被关掉，工具全部由 Pi 助理执行并走审批。
				<br />
				Codex 的配置、规则、登录与历史使用 Pi 专用目录；Mac 钥匙串是否共用尚未实测，公司强制设置不在隔离范围内。
				<br />
				用量只显示 token 数，不显示钱（费用走你的 ChatGPT 订阅或账户）。
			</>
		),
	},
	antigravity: {
		title: "Antigravity（本机）",
		command: "agy",
		login: "agy",
		tone: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
		summary: "实验性：用你电脑上已登录的 Antigravity（agy）当模型，工具仍由 Pi 助理执行。",
		models: "模型：Antigravity · 以 agy 自己的列表为准（Gemini 在部分地区不可用）",
		help: (
			<>
				实验性功能。只当「大脑」用：Antigravity 自带的工具都会被关掉，工具全部由 Pi 助理执行并走审批。
				<br />
				启动比较慢（每个对话首次约半分钟），看不到思考过程；你在它干活时插的话，会等它用完下一个工具后才看到。
				<br />
				Gemini 模型在部分地区不可用，可选 Claude 或 GPT-OSS。对话记录会出现在 Antigravity 自己的历史里。
				<br />
				用量只显示 token 数，不显示钱。
			</>
		),
	},
	"opencode-cli": {
		title: "OpenCode",
		command: "opencode",
		login: "opencode auth login",
		tone: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
		summary: "用 OpenCode 当模型，带免费模型，工具由 Pi 执行；Pi 单独装一份，和你电脑上的设置、登录完全分开。",
		models: "模型：以 OpenCode 自己的列表为准，名字里标明来源",
		loginOptional: "没登录也能用它的免费模型。",
		help: (
			<>
				只当「大脑」用：OpenCode 自带的读写文件、执行命令、联网等工具都会被关掉，工具全部由 Pi 助理执行并走审批。
				<br />
				名字里的「OpenCode Zen 按量」会扣你的 Zen 余额，「OpenCode Go」用你的 Go 套餐，「免费」不花钱；你自己用 opencode auth login 登录的模型服务显示它自己的名字。
				<br />
				配置、规则、登录和对话历史使用 Pi 专用目录。Mac 钥匙串是否共用尚未实测，公司强制设置不在隔离范围内。
				<br />
				你在它干活时插的话，会等它用完下一个工具后才看到。用量只显示 token 数（最后一次调用的），不显示钱。
			</>
		),
	},
};

export function CliAgentCard({ kind, onChanged }: { kind: CliKind; onChanged?: () => void }) {
	const k = KINDS[kind];
	const native = kind !== "antigravity";
	const [info, setInfo] = useState<CliInfo | null>(null);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const changed = useRef(onChanged);
	changed.current = onChanged;
	const check = useCallback(async (recheck: boolean) => {
		setBusy(true);
		try {
			const r = await api<CliInfo>(`/api/models/${kind}` + (recheck ? "/recheck" : ""), recheck ? { method: "POST" } : {});
			setInfo((prev) => (setErr(""), r.registered && !prev?.registered && changed.current?.(), r));
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, [kind]);
	useEffect(() => {
		void check(false);
	}, [check]);
	useEffect(() => {
		if (!native || !info?.operation) return;
		const timer = window.setInterval(() => void check(false), 1000);
		return () => window.clearInterval(timer);
	}, [native, info?.operation, check]);
	const action = async (name: string) => {
		setBusy(true);
		setErr("");
		try {
			await api(`/api/models/${kind}/${name}`, { method: "POST", body: JSON.stringify({ methodId: info?.authMethods?.[0]?.id }) });
			await check(false);
			changed.current?.();
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally { setBusy(false); }
	};
	const ready = !!info?.installed && (info.loggedIn || (!!k.loginOptional && info.registered));
	return (
		<div className="space-y-2 rounded-xl border border-line p-3" data-testid={`${kind}-card`} data-installed={String(!!info?.installed)} data-logged-in={String(!!info?.loggedIn)} data-registered={String(!!info?.registered)}>
			<div className="flex items-center gap-2.5">
				<span aria-hidden className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${k.tone}`}>
					<Terminal size={18} />
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-1.5">
						<span className="text-sm font-medium">{k.title}</span>
						{ready && <CheckCircle2 size={14} className="shrink-0 text-emerald-500" aria-label="可用" />}
						<Help>{k.help}</Help>
					</div>
					<div className="text-[11px] text-mut">{k.summary}</div>
				</div>
				<div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5" data-testid={`${kind}-actions`}>
					{native && info && (info.operation ? (
						<Button size="sm" variant="outline" disabled={busy} onClick={() => void action("cancel")}>取消</Button>
					) : !info.installed ? (
						<Button size="sm" disabled={busy} onClick={() => void action("install")}><Download size={13} /> 安装</Button>
					) : !info.loggedIn ? (
						<Button size="sm" disabled={busy} onClick={() => void action("login")}><LogIn size={13} /> 登录</Button>
					) : info.updateAvailable ? (
						<Button size="sm" disabled={busy} onClick={() => void action("update")}>更新到 v{info.latestVersion}</Button>
					) : (
						<Button size="sm" variant="outline" disabled={busy} onClick={() => void action("check-update")}>检查更新</Button>
					))}
					<Button size="sm" variant="outline" disabled={busy || !!info?.operation} onClick={() => void check(true)} data-testid={`${kind}-recheck`}>
						<RefreshCw size={13} className={busy ? "animate-spin" : undefined} /> 重新检测
					</Button>
				</div>
			</div>
			<div className="flex flex-wrap items-center gap-1.5 text-xs" data-testid={`${kind}-status`}>
				{!info ? (
					<span className="text-mut">{err ? `检测失败：${err}` : "正在检测…"}</span>
				) : !info.installed ? (
					<Badge tone="amber">没装</Badge>
				) : (
					<>
						<Badge tone="green">已安装{info.version ? ` v${info.version}` : ""}</Badge>
						<Badge tone={info.loggedIn ? "green" : k.loginOptional ? "zinc" : "amber"}>{info.loginUnverified ? "登录待验证" : info.loggedIn ? "已登录" : k.loginOptional ? "未登录（可用免费模型）" : "未登录"}</Badge>
						{info.untestedVersion && <Badge tone="zinc">这个版本还没测过</Badge>}
					</>
				)}
				{info?.operation && <span role="status" className="text-mut">{info.operation === "login" ? (kind === "opencode-cli" ? "正在登录，请在打开的终端里完成" : "正在登录，请在浏览器里完成") : info.operation === "install" ? "正在安装…" : "正在更新…"}</span>}
				{!info?.operation && info?.updateAvailable && <span className="text-mut">有新版本 v{info.latestVersion}</span>}
				{info?.registered && <span className="text-mut">{k.models}</span>}
			</div>
			{err && info && <div role="alert" className="break-words text-xs text-red-500">{err}</div>}
			{info && !info.installed && !native && (
				<div className="text-[11px] text-mut2" data-testid={`${kind}-hint`}>
					这台电脑上没有找到 {k.command} 命令。先按 {k.title.replace("（本机）", "")} 官方说明安装，装好后点「重新检测」，不用重启。
				</div>
			)}
			{!native && info?.installed && !info.loggedIn && !info.loginUnverified && (
				<div className="text-[11px] text-mut2" data-testid={`${kind}-hint`}>
					{k.loginOptional ?? "还没登录。打开终端，运行"} <code className="rounded bg-hover px-1">{k.login}</code> 登录，{k.loginOptional ? "再" : "然后"}点「重新检测」。
				</div>
			)}
			{kind === "claude-code" && <ClaudeCustomModels onChanged={onChanged} />}
			{info?.error && ((native && info.installed) || (info.installed && info.loggedIn === false)) && <div className="break-all text-[11px] text-mut2">{info.error}</div>}
		</div>
	);
}

/** Claude Code 的「自定义模型」：填 `claude --model` 能接受的模型 ID，存服务端设置，改了立刻重新注册模型列表 */
function ClaudeCustomModels({ onChanged }: { onChanged?: () => void }) {
	const [list, setList] = useState<string[]>([]);
	const [id, setId] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const [open, setOpen] = useState(false);
	const url = "/api/models/claude-code/custom-models";
	useEffect(() => {
		api<{ models: string[] }>(url).then((r) => setList(r.models), () => {});
	}, []);
	const run = async (path: string, init: RequestInit, done?: () => void) => {
		setBusy(true);
		try {
			setList((await api<{ models: string[] }>(path, init)).models);
			setErr("");
			done?.();
			onChanged?.();
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="border-t border-line pt-2 text-xs" data-testid="claude-custom-models">
			{/* 专业设置：默认收起（界面标准），标题旁显示已加几个 */}
			<Fold title="自定义模型" count={list.length} hint="选不到的版本可以加在这里" open={open} onToggle={() => setOpen(!open)} testId="claude-custom-fold">
				<div className="mt-1.5 space-y-1.5">
					<div className="text-[11px] text-mut">填 claude --model 能接受的模型 ID（比如 claude-opus-4-8）。填错的 ID 要到发消息时才会报错。</div>
					<form
						className="flex gap-1.5"
						onSubmit={(e) => {
							e.preventDefault();
							void run(url, { method: "POST", body: JSON.stringify({ id: id.trim() }) }, () => setId(""));
						}}
					>
						<Input value={id} onChange={(e) => setId(e.target.value)} placeholder="例如 claude-opus-4-8" maxLength={100} data-testid="claude-custom-input" />
						<Button size="sm" type="submit" disabled={busy || !id.trim()} data-testid="claude-custom-add">
							<Plus size={13} /> 添加
						</Button>
					</form>
					{err && <div className="text-[11px] text-red-500">{err}</div>}
					{list.length > 0 && (
						<ul className="max-h-32 space-y-1 overflow-y-auto" data-testid="claude-custom-list">
							{list.map((m) => (
								<li key={m} className="flex items-center gap-1.5 text-xs">
									<code className="min-w-0 flex-1 truncate rounded bg-hover px-1">{m}</code>
									<Button size="icon" variant="ghost" aria-label={`删除 ${m}`} disabled={busy} onClick={() => void run(`${url}?id=${encodeURIComponent(m)}`, { method: "DELETE" })}>
										<X size={13} />
									</Button>
								</li>
							))}
						</ul>
					)}
				</div>
			</Fold>
		</div>
	);
}

/** 模型服务页里的全部编程工具卡片：会越来越多，默认折叠、显示数量，展开后限高内部滚动 */
export function CliAgentCards({ onChanged }: { onChanged?: () => void }) {
	const [open, setOpen] = useState(false);
	return (
		<Fold testId="cli-agents" icon={Terminal} title="编程工具" count={CLI_KINDS.length} hint="Claude Code、Codex、Gemini CLI 等，装好登录后可当助理的模型用" open={open} onToggle={() => setOpen((v) => !v)}>
			<div className="max-h-[60dvh] space-y-2 overflow-y-auto pr-1" data-testid="cli-agents-list">
				{CLI_KINDS.map((k) => (
					<CliAgentCard key={k} kind={k} onChanged={onChanged} />
				))}
			</div>
		</Fold>
	);
}
