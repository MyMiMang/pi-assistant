/**
 * 设置 › 模型服务里的「Claude Code（本机）」卡片（方案 docs/design/cli-models.md §4.5）。
 * 只显示本机检测结果（装没装、版本、登录没登录）并提供「重新检测」；登录要用户自己在终端里做，我们不代为登录。
 * 检测到已安装后服务端就地注册模型渠道（不用重启），模型出现在所有模型选择里。
 */
import { CheckCircle2, RefreshCw, Terminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Badge, Button, Help } from "./ui";

interface ClaudeCodeInfo {
	installed: boolean;
	version?: string;
	loggedIn: boolean;
	authMethod?: string;
	error?: string;
	registered: boolean;
}

export function ClaudeCodeCard({ onChanged }: { onChanged?: () => void }) {
	const [info, setInfo] = useState<ClaudeCodeInfo | null>(null);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const changed = useRef(onChanged);
	changed.current = onChanged;
	const check = useCallback(async (recheck: boolean) => {
		setBusy(true);
		try {
			const r = await api<ClaudeCodeInfo>("/api/models/claude-code" + (recheck ? "/recheck" : ""), recheck ? { method: "POST" } : {});
			setInfo((prev) => (setErr(""), recheck && r.registered && !prev?.registered && changed.current?.(), r));
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, []);
	useEffect(() => {
		void check(false);
	}, [check]);
	const ready = !!info?.installed && info.loggedIn;
	return (
		<div className="space-y-2 rounded-xl border border-line p-3" data-testid="claude-code-card" data-installed={String(!!info?.installed)} data-logged-in={String(!!info?.loggedIn)} data-registered={String(!!info?.registered)}>
			<div className="flex items-center gap-2.5">
				<span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
					<Terminal size={18} />
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-1.5">
						<span className="text-sm font-medium">Claude Code（本机）</span>
						{ready && <CheckCircle2 size={14} className="shrink-0 text-emerald-500" aria-label="可用" />}
						<Help>
							会加载你自己的 Claude Code 设置（登录方式、代理、钩子、插件都按你的设置来），但不会读你的 CLAUDE.md。
							<br />
							Claude Code 的会话记录会出现在它自己的历史里。
							<br />
							用量只显示 token 数，不显示钱（费用走你的 Claude 订阅或账户）。
						</Help>
					</div>
					<div className="text-[11px] text-mut">用你电脑上已登录的 Claude Code 当模型，工具仍由 Pi 助理执行。</div>
				</div>
				<Button size="sm" variant="outline" disabled={busy} onClick={() => void check(true)} data-testid="claude-code-recheck">
					<RefreshCw size={13} className={busy ? "animate-spin" : undefined} /> 重新检测
				</Button>
			</div>
			<div className="flex flex-wrap items-center gap-1.5 text-xs" data-testid="claude-code-status">
				{!info ? (
					<span className="text-mut">{err ? `检测失败：${err}` : "正在检测…"}</span>
				) : !info.installed ? (
					<Badge tone="amber">没装</Badge>
				) : (
					<>
						<Badge tone="green">已安装{info.version ? ` v${info.version}` : ""}</Badge>
						<Badge tone={info.loggedIn ? "green" : "amber"}>{info.loggedIn ? "已登录" : "未登录"}</Badge>
					</>
				)}
				{info?.registered && <span className="text-mut">模型：Claude Code · Opus / Sonnet / Haiku</span>}
			</div>
			{info && !info.installed && (
				<div className="text-[11px] text-mut2" data-testid="claude-code-hint">
					这台电脑上没有找到 claude 命令。先按 Claude Code 官方说明安装，装好后点「重新检测」，不用重启。
				</div>
			)}
			{info?.installed && !info.loggedIn && (
				<div className="text-[11px] text-mut2" data-testid="claude-code-hint">
					还没登录。打开终端，运行 <code className="rounded bg-hover px-1">claude auth login</code> 登录，然后点「重新检测」。
				</div>
			)}
			{info?.error && info.installed && info.loggedIn === false && <div className="break-all text-[11px] text-mut2">{info.error}</div>}
		</div>
	);
}
