/**
 * 设置 › 模型服务里的「本机命令行模型」卡片（Claude Code / Codex / Antigravity / OpenCode 共用；方案 docs/design/cli-models.md §4.5、§5.2、§5b，docs/design/acp-cli-models.md）。
 * 全部渠道使用 Pi 私有安装，提供安装、官方登录、取消和手动更新。
 * 检测到可用后服务端就地注册模型渠道（不用重启），模型出现在所有模型选择里。
 * 原生工具从 shared 的 NATIVE_ACP_AGENTS 生成卡片，服务端接口按渠道名对应。
 */
import { NATIVE_ACP_AGENTS, type NativeCliStatus, type NativeProviderId } from "@pi-assistant/shared";
import { CheckCircle2, Download, LogIn, Plus, RefreshCw, Terminal, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, api, base } from "../api";
import { Badge, Button, Fold, Help, Input, Modal, useConfirm } from "./ui";

interface CliInfo extends NativeCliStatus {
	/** Codex：`~/.codex/AGENTS.md` 存在（只检查文件在不在） */
	globalAgentsMd?: boolean;
}

/** `opencode-cli`：不叫 `opencode`，Pi 自带一个同名的 OpenCode Zen 密钥渠道 */
type BrainKind = "claude-code" | "codex" | "antigravity" | "opencode-cli";
export type CliKind = BrainKind | NativeProviderId;
/** 模型服务页里要显示的编程工具渠道，也从普通服务列表里去掉。 */
const BRAIN_KINDS: BrainKind[] = ["claude-code", "codex", "antigravity", "opencode-cli"];
export const CLI_KINDS: CliKind[] = [...BRAIN_KINDS, ...NATIVE_ACP_AGENTS.map((agent) => agent.provider)];

/** 每家的文案：命令名、登录命令、一句话说明、「?」说明、已注册后显示的模型 */
const NATIVE_HELP = <>工具会在助理工作文件夹内使用自己的读写文件和执行命令能力，也能调用 Pi 工具。部分读取不会逐项请求批准；工具实际发来的批准请求按助理的权限档位处理，完全权限直接允许一次，其他档位由你逐项批准。配置目录独立，但 Mac 钥匙串中的登录可能共用。工具使用自身能力执行时，你的插话会在这轮结束后送达。</>;

interface CardCopy { title: string; command: string; login: string; tone: string; summary: string; models: string; help: ReactNode; loginOptional?: string }
const BRAIN_CARDS: Record<BrainKind, CardCopy> = {
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
		title: "Antigravity",
		command: "agy",
		login: "agy",
		tone: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
		summary: "用 Antigravity 当模型，工具由 Pi 助理执行；Pi 单独装一份，配置、登录和历史使用专用目录。",
		models: "模型：Antigravity · 以 agy 自己的列表为准（Gemini 在部分地区不可用）",
		help: (
			<>
				只当「大脑」用：Antigravity 自带的工具都会被关掉，工具全部由 Pi 助理执行并走审批。安装时从 Google 下载专有软件，不随 App 分发；由你手动更新。
				<br />
				启动比较慢（每个对话首次约半分钟），看不到思考过程；你在它干活时插的话，会等它用完下一个工具后才看到。
				<br />
				Gemini 模型在部分地区不可用，可选 Claude 或 GPT-OSS。配置和会话在 Pi 专用 HOME 下；系统钥匙串可能共用，尚未实测。常规登录由 Antigravity 完成。
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

const KINDS = {
	...BRAIN_CARDS,
	...Object.fromEntries(NATIVE_ACP_AGENTS.map((agent) => [agent.provider, {
		title: agent.name, command: "", login: "", tone: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
		summary: `${agent.summary.replace(/[。；;\s]+$/, "")}；Pi 单独装一份，和你电脑上的设置、登录完全分开。`,
		models: "模型：以工具自己提供的列表为准",
		help: <>{NATIVE_HELP}{agent.limitations.map((limitation) => <p key={limitation} className="mt-1.5">{limitation}</p>)}</>,
	}])),
} as Record<CliKind, CardCopy>;
type StatusReport = (kind: CliKind, info: CliInfo) => void;

export function CliAgentCard({ kind, onChanged, onStatus }: { kind: CliKind; onChanged?: () => void; onStatus?: StatusReport }) {
	const k = KINDS[kind];
	const [info, setInfo] = useState<CliInfo | null>(null);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const changed = useRef(onChanged);
	const previous = useRef<CliInfo | null>(null);
	changed.current = onChanged;
	useEffect(() => { if (info) onStatus?.(kind, info); }, [info, kind, onStatus]);
	const check = useCallback(async (recheck: boolean) => {
		setBusy(true);
		try {
			const r = await api<CliInfo>(`/api/models/${kind}` + (recheck ? "/recheck" : ""), recheck ? { method: "POST" } : {});
			setErr("");
			if (r.registered && !previous.current?.registered) changed.current?.();
			previous.current = r;
			setInfo(r);
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
		if (!info?.operation) return;
		const timer = window.setInterval(() => void check(false), 1000);
		return () => window.clearInterval(timer);
	}, [info?.operation, check]);
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
	const supported = info?.platformSupported !== false;
	const apiKey = info?.authType === "api-key";
	const ready = supported && !!info?.installed && !!info.registered && (info.loggedIn || !!k.loginOptional);
	return (
		<div className="space-y-2 rounded-xl border border-line p-3" data-testid={`${kind}-card`} data-installed={String(!!info?.installed)} data-logged-in={String(!!info?.loggedIn)} data-registered={String(!!info?.registered)} data-platform-supported={String(supported)}>
			<div className="flex flex-wrap items-center gap-2.5">
				<span aria-hidden className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${k.tone}`}>
					<Terminal size={18} />
				</span>
				<div className="min-w-0 flex-1 break-words">
					<div className="flex flex-wrap items-center gap-1.5">
						<span className="text-sm font-medium">{k.title}</span>
						{ready && <CheckCircle2 size={14} className="shrink-0 text-emerald-500" aria-label="可用" />}
						<Help>{k.help}</Help>
					</div>
					<div className="text-[11px] text-mut">{k.summary}</div>
				</div>
				<div className="flex w-full shrink-0 flex-wrap items-center justify-end gap-1.5 sm:w-auto" data-testid={`${kind}-actions`}>
					{info && (!supported ? (
						<Button size="sm" disabled><Download size={13} /> 安装</Button>
					) : info.operation ? (
						<Button size="sm" variant="outline" disabled={busy} onClick={() => void action("cancel")}>取消</Button>
					) : !info.installed ? (
						<Button size="sm" disabled={busy} onClick={() => void action("install")}><Download size={13} /> 安装</Button>
					) : !info.loggedIn && !apiKey ? (
						<Button size="sm" disabled={busy} onClick={() => void action("login")}><LogIn size={13} /> 登录</Button>
					) : info.updateAvailable ? (
						<Button size="sm" disabled={busy} onClick={() => void action("update")}>更新到 v{info.latestVersion}</Button>
					) : (
						<Button size="sm" variant="outline" disabled={busy} onClick={() => void action("check-update")}>检查更新</Button>
					))}
					{kind === "antigravity" && isLocalAgyPage() && (
						<AgyAccounts canImportBesideLogin={!!info?.installed && !info.loggedIn && supported && !apiKey && !info.operation}
							disabled={busy || !!info?.operation} loggedIn={info?.loggedIn} onChanged={() => void check(false)} />
					)}
					<Button size="sm" variant="outline" disabled={busy || !!info?.operation} onClick={() => void check(true)} data-testid={`${kind}-recheck`}>
						<RefreshCw size={13} className={busy ? "animate-spin" : undefined} /> 重新检测
					</Button>
				</div>
			</div>
			<div className="flex flex-wrap items-center gap-1.5 text-xs" data-testid={`${kind}-status`}>
				{!info ? (
					<span className="text-mut">{err ? `检测失败：${err}` : "正在检测…"}</span>
				) : !supported ? (
					<Badge tone="zinc">这个平台暂不支持</Badge>
				) : !info.installed ? (
					<Badge tone="amber">没装</Badge>
				) : (
					<>
						<Badge tone="green">已安装{info.version ? ` v${info.version}` : ""}</Badge>
						<Badge tone={info.loggedIn ? "green" : k.loginOptional ? "zinc" : "amber"}>{apiKey ? (info.loggedIn ? "已配置" : "需要在工具里配置") : info.loginUnverified ? "登录待验证" : info.loggedIn ? "已登录" : k.loginOptional ? "未登录（可用免费模型）" : "未登录"}</Badge>
						{info.untestedVersion && <Badge tone="zinc">这个版本还没测过</Badge>}
					</>
				)}
				{info?.operation && <span role="status" className="text-mut">{info.operation === "login" ? (info.authType === "terminal" || kind === "opencode-cli" || kind === "antigravity" ? "正在登录，请在打开的终端里完成" : "正在登录，请在浏览器里完成") : info.operation === "install" ? "正在安装…" : "正在更新…"}</span>}
				{supported && apiKey && <span className="text-mut">需要在工具里配置自己的模型服务，配好后点「重新检测」。</span>}
				{!info?.operation && info?.updateAvailable && <span className="text-mut">有新版本 v{info.latestVersion}</span>}
				{!info?.operation && info?.updateBlocked && <span className="text-mut">有新版本 v{info.latestVersion}，{info.updateBlocked}</span>}
				{info?.registered && <span className="text-mut">{k.models}</span>}
			</div>
			{err && info && <div role="alert" className="break-words text-xs text-red-500">{err}</div>}
			{kind === "claude-code" && <ClaudeCustomModels onChanged={onChanged} />}
			{/* 装好但没登录时检测报的「需要登录」不显示：「未登录」标签已经说明了；只显示安装失败和真正的检测异常 */}
			{info?.error && (!info.installed || info.loggedIn || info.loginUnverified) && <div className="break-all text-[11px] text-red-500" role="alert" data-testid={`${kind}-error`}>{info.installed ? info.error : `安装失败：${info.error}`}</div>}
		</div>
	);
}

const AGY_ACCOUNTS_URL = "/api/agy-rt-import";
const AGY_IMPORT_UNAVAILABLE = "此版本暂不支持多账号管理，请使用原来的登录方式。";
const AGY_IMPORT_LABEL = "用 RT 导入账号";
const AGY_GOOGLE_ADD_LABEL = "用 Google 登录添加";
const AGY_ACCOUNTS_LABEL = "管理账号";
const AGY_ACCOUNT_STATES = { ready: "可用", invalid: "凭据失效", unknown: "状态未知" } as const;
type AgyIdentity = { subject: string; email: string };
type AgyGoogleLoginStatus =
	| { state: "running" }
	| { state: "succeeded"; email?: string }
	| { state: "failed"; code?: string }
	| { state: "cancelled" };
type AgyAccountStatus = {
	available: boolean;
	canAdd?: boolean;
	canSwitch?: boolean;
	canGoogleLogin?: boolean;
	googleLogin?: AgyGoogleLoginStatus | null;
	addReason?: string | null;
	current: AgyIdentity | null;
	accounts: (AgyIdentity & { state: keyof typeof AGY_ACCOUNT_STATES; source?: "google" | "rt" })[];
};

function isLocalAgyPage() {
	return !base() && ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
}

function agyAccountsApi<T>(suffix = "", json?: object, signal?: AbortSignal) {
	// 不向配对服务器或重定向目标发送凭据；服务端仍须独立验证请求来自本机。
	if (!isLocalAgyPage()) throw new ApiError(403, "local_only");
	return api<T>(AGY_ACCOUNTS_URL + suffix, { method: json ? "POST" : "GET", json, signal, redirect: "error", cache: "no-store" });
}

function agyAccountError(error: unknown, operation: "add" | "switch" | "switch-google" | "remove" | "google-login/start" | "google-login/cancel") {
	// 只显示固定文案，不回显接口错误、凭据或 CLI 输出。
	if (error instanceof ApiError) {
		if ([403, 404, 501, 503].includes(error.status)) return AGY_IMPORT_UNAVAILABLE;
		if (error.status === 409) return "账号正在使用或处理，请稍后再试。";
	}
	if (operation === "switch") return "未能确认账号已切换，请核对当前账号。";
	if (operation === "switch-google") return "未能切回原 Google 登录，请稍后重试。";
	if (operation === "remove") return "未能确认账号已移除，请核对列表。";
	if (operation === "google-login/start") return "未能启动 Google 登录，请稍后重试。";
	if (operation === "google-login/cancel") return "未能取消 Google 登录，请关闭终端窗口后重试。";
	return "未能验证并添加账号，请核对 RT 是否有效、网络是否正常。";
}

function agyGoogleLoginError(code?: string) {
	if (code === "invalid_account") return "Google 登录未通过账号验证，请重新登录。";
	if (code === "import_unavailable") return AGY_IMPORT_UNAVAILABLE;
	return "未能完成 Google 登录添加，请确认已在打开的终端里完成授权并重试。";
}

function AgyAccounts({ canImportBesideLogin, disabled, loggedIn, onChanged }: {
	canImportBesideLogin: boolean; disabled: boolean; loggedIn?: boolean; onChanged: () => void;
}) {
	const [status, setStatus] = useState<AgyAccountStatus | null>();
	const [open, setOpen] = useState(false);
	const [adding, setAdding] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [confirmDialog, confirm] = useConfirm();
	const tokenInput = useRef<HTMLInputElement>(null);
	const pending = useRef(false);
	const statusRequest = useRef(0);
	const googleRunning = status?.googleLogin?.state === "running";

	const refresh = useCallback(async (signal?: AbortSignal) => {
		const request = ++statusRequest.current;
		let next: AgyAccountStatus | null = null;
		try {
			const result = await agyAccountsApi<AgyAccountStatus>("", undefined, signal);
			// 老接口只返回 available，不能把旧的「导入并激活」端点当成「只添加」。
			if (typeof result?.available === "boolean" && result.current !== undefined && Array.isArray(result.accounts)) next = result;
		} catch { /* 不显示原始响应 */ }
		if (!signal?.aborted && request === statusRequest.current) setStatus(next);
		return next;
	}, []);
	useEffect(() => {
		const controller = new AbortController();
		if (!pending.current) void refresh(controller.signal);
		return () => controller.abort();
	}, [loggedIn, refresh]);
	useEffect(() => {
		if (!googleRunning) return;
		const timer = window.setInterval(() => {
			if (!pending.current) void refresh();
		}, 1200);
		return () => window.clearInterval(timer);
	}, [googleRunning, refresh]);

	const mutate = async (...[operation, payload]: ["add", { refreshToken: string }] | ["switch" | "remove", { subject: string }] | ["switch-google" | "google-login/start" | "google-login/cancel", Record<string, never>]) => {
		if (pending.current || disabled || status?.available !== true || (operation === "add" && status.canAdd === false) || (operation === "switch" && status.canSwitch === false) || (operation === "google-login/start" && !status.canGoogleLogin)) return;
		pending.current = true;
		setBusy(true);
		setError("");
		let changed = false;
		try {
			if (operation === "add") {
				const result = await agyAccountsApi<{ email: string }>("", payload);
				if (typeof result?.email !== "string" || !result.email) throw new Error();
				setAdding(false);
			} else {
				await agyAccountsApi(`/${operation}`, payload);
				if (operation === "google-login/start") setAdding(false);
			}
			changed = true;
		} catch (e) {
			setError(agyAccountError(e, operation));
		} finally {
			const refreshed = await refresh();
			if (changed && !refreshed) setError("未能刷新账号列表，请重新打开查看。");
			else if (changed && operation === "switch" && refreshed?.current?.subject !== payload.subject) setError(agyAccountError(null, operation));
			pending.current = false;
			setBusy(false);
			if (operation === "switch" || operation === "switch-google" || operation === "remove") onChanged();
		}
	};
	const show = (add: boolean) => {
		setError("");
		setAdding(add);
		setOpen(true);
		setStatus(undefined);
		void refresh();
	};
	const close = () => {
		if (!pending.current) {
			setOpen(false);
			setAdding(false);
		}
	};
	const currentText = status?.current?.email ?? (status?.available ? (loggedIn ? "Google 账号登录" : "未登录") : "未知");
	return (
		<>
			{canImportBesideLogin && status?.available === true && status.canAdd !== false && (
				<Button size="sm" variant="outline" disabled={disabled || busy || googleRunning} aria-haspopup="dialog" onClick={() => show(true)}>{AGY_IMPORT_LABEL}</Button>
			)}
			<span className="min-w-0 break-all text-xs text-mut">当前账号：{currentText}{googleRunning ? "（正在 Google 登录…）" : ""}</span>
			<Button size="sm" variant="outline" disabled={disabled || busy} aria-haspopup="dialog" onClick={() => show(false)}>{AGY_ACCOUNTS_LABEL}</Button>
			<Modal open={open} onClose={close} title={AGY_ACCOUNTS_LABEL} ariaLabel={AGY_ACCOUNTS_LABEL}>
				<div className="space-y-3 p-5 text-sm" aria-busy={busy}>
					<div className="flex flex-wrap items-center justify-between gap-2">
						<p className="min-w-0 break-all">当前账号：{currentText}</p>
						{status?.available === true && status.current && (
							<Button size="sm" variant="ghost" disabled={disabled || busy || googleRunning} onClick={() => void mutate("switch-google", {})}>切回原 Google 登录</Button>
						)}
					</div>
					{status === undefined ? <p role="status" className="text-mut">正在读取账号…</p> : status?.available !== true ? (
						<p className="text-mut">{status?.addReason === "protected_storage_unavailable" ? "安全存储不可用，暂不能管理多账号。原登录不受影响。" : AGY_IMPORT_UNAVAILABLE}</p>
					) : (
						<>
							<p className="text-xs text-mut">支持用 Google 登录或 RT 添加多个账号并随时切换；只影响 Pi 里的反重力，不动你电脑上单独打开的反重力。添加后不会自动切换，当前使用中的账号不能移除。</p>
							{status.canAdd === false && <p className="text-xs text-mut">{status.addReason === "cli_not_installed" ? "请先安装 Antigravity，再添加或切换账号。" : "当前环境暂不支持添加账号。"}</p>}
							{status.accounts.length > 0 ? (
								<ul className="max-h-56 space-y-2 overflow-y-auto" aria-label="已导入账号">
									{status.accounts.map((account) => {
										const current = status.current?.subject === account.subject;
										const sourceLabel = account.source === "google" ? "Google 登录 · " : account.source === "rt" ? "RT · " : "";
										return (
											<li key={account.subject} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2">
												<div className="min-w-0 flex-1 break-all">
													<div>{account.email}</div>
													<div className="text-xs text-mut">{current ? "当前使用 · " : ""}{sourceLabel}{AGY_ACCOUNT_STATES[account.state] ?? "状态未知"}</div>
												</div>
												{!current && status.canSwitch !== false && <Button size="sm" variant="outline" disabled={disabled || busy || googleRunning || account.state === "invalid"} onClick={() => void mutate("switch", { subject: account.subject })}>切换到此账号</Button>}
												<Button size="sm" variant="ghost" disabled={disabled || busy || googleRunning || current} onClick={async () => {
													if (await confirm({ title: "移除账号？", body: <span className="break-all">确定移除 {account.email}？</span>, ok: "移除", danger: true })) {
														await mutate("remove", { subject: account.subject });
													}
												}}>移除</Button>
											</li>
										);
									})}
								</ul>
							) : <p className="text-mut">还没有添加的账号。</p>}
							{status.googleLogin?.state === "succeeded" && status.googleLogin.email && (
								<p role="status" className="text-xs text-emerald-600 dark:text-emerald-400">已添加账号 {status.googleLogin.email}，点击上方「切换到此账号」即可启用。</p>
							)}
							{status.googleLogin?.state === "cancelled" && !error && (
								<p role="status" className="text-xs text-mut">已取消 Google 登录。</p>
							)}
							{status.googleLogin?.state === "failed" && !error && (
								<p role="alert" className="text-xs text-red-500">{agyGoogleLoginError(status.googleLogin.code)}</p>
							)}
							{status.canAdd === false ? null : googleRunning ? (
								<div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-hover/40 p-2.5 text-xs">
									<span role="status" className="text-mut">正在用 Google 登录添加账号，请在打开的终端里完成授权…</span>
									<Button size="sm" variant="outline" disabled={busy} onClick={() => void mutate("google-login/cancel", {})}>取消登录</Button>
								</div>
							) : adding ? (
								<form autoComplete="off" className="space-y-2 border-t border-line pt-3" onSubmit={(e) => {
									e.preventDefault();
									if (!tokenInput.current) return;
									const refreshToken = tokenInput.current.value.trim();
									e.currentTarget.reset();
									if (refreshToken) void mutate("add", { refreshToken });
									else setError("请填写 RT。");
								}}>
									<label className="block space-y-1">刷新令牌（RT）<Input ref={tokenInput} className="w-full" type="password" required autoComplete="new-password" spellCheck={false} maxLength={4096} disabled={disabled || busy} /></label>
									<div className="flex justify-end gap-2">
										<Button size="sm" type="button" variant="ghost" disabled={busy} onClick={() => { setAdding(false); setError(""); }}>取消添加</Button>
										<Button size="sm" type="submit" variant="primary" disabled={disabled || busy}>添加账号</Button>
									</div>
								</form>
							) : (
								<div className="flex flex-wrap gap-2">
									{status.canGoogleLogin && (
										<Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => void mutate("google-login/start", {})}><LogIn size={13} /> {AGY_GOOGLE_ADD_LABEL}</Button>
									)}
									<Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => { setAdding(true); setError(""); }}>{AGY_IMPORT_LABEL}</Button>
								</div>
							)}
						</>
					)}
					{busy && <p role="status" className="text-mut">正在处理…</p>}
					{error && <p role="alert" className="text-red-500">{error}</p>}
				</div>
			</Modal>
			{confirmDialog}
		</>
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
	const [statuses, setStatuses] = useState<Partial<Record<CliKind, CliInfo>>>({});
	const reportStatus = useCallback<StatusReport>((kind, info) => {
		setStatuses((prev) => {
			const old = prev[kind];
			if (old?.installed === info.installed && old?.registered === info.registered && old?.platformSupported === info.platformSupported) return prev;
			return { ...prev, [kind]: info };
		});
	}, []);
	const rank = (kind: CliKind) => {
		const info = statuses[kind];
		return info?.platformSupported === false ? 3 : info?.registered ? 0 : info?.installed ? 1 : 2;
	};
	const sorted = [...CLI_KINDS].sort((a, b) => rank(a) - rank(b));
	return (
		<Fold testId="cli-agents" icon={Terminal} title="编程工具" count={CLI_KINDS.length} hint="Claude Code、Codex、Gemini CLI 等，装好登录后可当助理的模型用" open={open} onToggle={() => setOpen((v) => !v)}>
			<div className="max-h-[60dvh] space-y-2 overflow-y-auto pr-1" data-testid="cli-agents-list">
				{sorted.map((k) => (
					<CliAgentCard key={k} kind={k} onChanged={onChanged} onStatus={reportStatus} />
				))}
			</div>
		</Fold>
	);
}
