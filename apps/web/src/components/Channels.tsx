import { CheckCircle2, ChevronDown, Copy, Loader2, MessageSquare, Plus, RefreshCw, Trash2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { Badge, Button, cx, Input } from "./ui";

type Kind = "wecom" | "feishu" | "dingtalk";
interface Channel {
	id: string;
	kind: Kind;
	name: string;
	agentId: string;
	enabled: boolean;
	config: Record<string, string>;
	secretsSet: string[];
	bindCode: string | null;
	status: { state: string; detail: string };
	users: { id: string; display: string | null; allowed: boolean; lastAt: number | null }[];
	callbackPath?: string;
}

const KINDS: Record<Kind, { label: string; mode: string; fields: { key: string; label: string; secret?: boolean; placeholder?: string }[]; steps: string[] }> = {
	feishu: {
		label: "飞书",
		mode: "长连接 · 不需要公网地址",
		fields: [
			{ key: "appId", label: "App ID", placeholder: "cli_xxxxxxxx" },
			{ key: "appSecret", label: "App Secret", secret: true },
		],
		steps: [
			"打开 飞书开放平台（open.feishu.cn）› 开发者后台 › 创建企业自建应用。",
			"应用能力 › 添加「机器人」。",
			"权限管理 › 开通：获取与发送单聊、群组消息（im:message）、以应用身份发消息（im:message:send_as_bot）。",
			"事件与回调 › 事件配置 › 订阅方式选「使用长连接接收事件」，添加事件「接收消息 v2.0」（im.message.receive_v1）。（先在这里保存凭据，长连接建立后飞书才允许保存这个选项。）",
			"凭证与基础信息 › 复制 App ID 和 App Secret 填到下面。",
			"版本管理与发布 › 创建版本并发布（企业管理员审核通过后生效）。",
			"在飞书里搜索这个机器人，发送「绑定 + 下面的 6 位绑定码」。",
		],
	},
	dingtalk: {
		label: "钉钉",
		mode: "Stream 模式 · 不需要公网地址",
		fields: [
			{ key: "clientId", label: "Client ID（原 AppKey）", placeholder: "dingxxxxxxxx" },
			{ key: "clientSecret", label: "Client Secret（原 AppSecret）", secret: true },
		],
		steps: [
			"打开 钉钉开放平台（open-dev.dingtalk.com）› 应用开发 › 企业内部应用 › 创建应用。",
			"添加应用能力 › 「机器人」，消息接收模式选「Stream 模式」，发布机器人。",
			"权限管理 › 申请「企业内机器人发送消息权限」（qyapi_robot_sendmsg），用于任务完成后主动通知你。",
			"凭证与基础信息 › 复制 Client ID 和 Client Secret 填到下面。",
			"版本管理与发布 › 发布应用（可见范围包含你自己）。",
			"在钉钉里搜索机器人（或在群里 @ 它），发送「绑定 + 下面的 6 位绑定码」。",
		],
	},
	wecom: {
		label: "企业微信",
		mode: "回调模式 · 需要公网地址（远程访问 / 固定地址）",
		fields: [
			{ key: "corpId", label: "企业 ID（CorpID）", placeholder: "ww..." },
			{ key: "agentId", label: "应用 AgentId", placeholder: "1000002" },
			{ key: "secret", label: "应用 Secret", secret: true },
			{ key: "token", label: "接收消息 Token", secret: true },
			{ key: "aesKey", label: "EncodingAESKey（43 位）", secret: true },
		],
		steps: [
			"先在「固定地址 / 入口」或「远程访问」里打开远程访问（企业微信只能把消息推到公网 HTTPS 地址，推荐固定地址）。",
			"打开 企业微信管理后台（work.weixin.qq.com）› 应用管理 › 自建 › 创建应用，记下 AgentId 和 Secret；我的企业 › 企业信息 › 复制企业 ID。",
			"把这些填到下面并保存，得到「回调地址」。",
			"应用详情 › 接收消息 › 设置 API 接收：URL 填回调地址，Token 和 EncodingAESKey 点「随机获取」后同样填到下面并保存，再回企业微信点保存（会校验一次）。",
			"应用详情 › 企业可信 IP：填这台电脑的公网出口 IP（不填的话助理回复会失败，错误码 60020）。",
			"在企业微信工作台打开这个应用，发送「绑定 + 下面的 6 位绑定码」。",
		],
	},
};
const STATE: Record<string, { tone: "green" | "amber" | "red" | "zinc"; label: string }> = {
	online: { tone: "green", label: "在线" },
	waiting: { tone: "amber", label: "等待回调" },
	connecting: { tone: "amber", label: "连接中" },
	error: { tone: "red", label: "出错" },
	off: { tone: "zinc", label: "已停用" },
};

export function ChannelsSettings() {
	const v = useStore((s) => s.channelsVersion);
	const agents = useStore((s) => s.agents);
	const [d, setD] = useState<{ items: Channel[]; publicUrl: string | null } | null>(null);
	const [adding, setAdding] = useState<Kind | null>(null);
	const load = () => api("/api/channels").then(setD);
	useEffect(() => void load(), [v]);
	if (!d) return null;
	return (
		<div className="space-y-5" data-testid="channels">
			<p className="text-sm text-mut">在企业微信、飞书、钉钉里直接和助理聊天：消息会进到助理的对话里，回复、需要你批准的操作、提问都会发回来（回复「批准」/「拒绝」或选项序号即可）。只有发送过绑定码的人才能使用。</p>
			{d.items.map((c) => (
				<ChannelCard key={c.id} c={c} publicUrl={d.publicUrl} agents={agents} onChange={load} />
			))}
			{adding ? (
				<ChannelForm kind={adding} agents={agents} publicUrl={d.publicUrl} onDone={() => (setAdding(null), void load())} />
			) : (
				<div className="flex flex-wrap gap-2">
					{(Object.keys(KINDS) as Kind[]).map((k) => (
						<Button key={k} size="sm" onClick={() => setAdding(k)} data-testid={`add-channel-${k}`}>
							<Plus size={14} /> 添加{KINDS[k].label}
						</Button>
					))}
				</div>
			)}
			<WechatSection agents={agents} />
		</div>
	);
}

/** 个人微信（可选，实验）：助理自己的微信号，跑在助理电脑里 */
function WechatSection({ agents }: { agents: { id: string; name: string; avatar: string }[] }) {
	const v = useStore((s) => s.channelsVersion);
	const [s, setS] = useState<{ enabled: boolean; acknowledgedAt: number | null; agentIds: string[] } | null>(null);
	const [ack, setAck] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [msg, setMsg] = useState("");
	const load = () => api("/api/wechat").then(setS);
	useEffect(() => void load(), [v]);
	if (!s) return null;
	const put = (json: Record<string, unknown>) => api("/api/wechat", { method: "PUT", json }).then(setS, (e) => setMsg(String(e.message ?? e)));
	const open = async (id: string) => {
		setBusy(id);
		setMsg("正在打开（第一次要下载安装微信，约几分钟）…");
		try {
			const r = await api(`/api/wechat/${id}/open`, { method: "POST" });
			setMsg(r.running ? "微信已在助理电脑里打开：到助理的「电脑」页扫码登录（用这个助理专用的微信号）。" : "微信没有启动起来");
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(null);
		}
	};
	return (
		<div className="space-y-3 rounded-2xl border border-line p-4" data-testid="wechat-section">
			<div className="flex items-center gap-2">
				<b>个人微信</b>
				<Badge>实验</Badge>
				<span className="ml-auto text-sm text-mut">{s.enabled ? "已开启" : "未开启"}</span>
			</div>
			<p className="text-sm text-mut">让助理在它自己的电脑里登录<b>它自己的</b>微信号（官方 Linux 版微信，由助理操作界面），可以帮你收发消息、看群、传文件。</p>
			<div className="rounded-xl bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300" data-testid="wechat-warning">
				⚠️ 风险提示：用程序操作个人微信不符合微信的服务条款，<b>账号可能被限制或封禁</b>。请准备一个<b>专门给助理用的微信小号</b>，不要用你的主号；不要让它批量加好友、群发消息。微信的聊天记录保存在这台电脑的助理电脑里。
			</div>
			{!s.acknowledgedAt ? (
				<div className="flex flex-wrap items-center gap-3">
					<label className="flex items-center gap-2 text-sm">
						<input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="wechat-ack" /> 我已了解风险，会使用专门的小号
					</label>
					<Button size="sm" variant="primary" disabled={!ack} onClick={() => put({ acknowledge: true, enabled: true })} data-testid="wechat-enable">
						开启个人微信
					</Button>
				</div>
			) : (
				<>
					<div className="text-sm">哪些助理有自己的微信：</div>
					<div className="flex flex-wrap gap-2">
						{agents.map((a) => {
							const on = s.agentIds.includes(a.id);
							return (
								<span key={a.id} className="flex items-center gap-1">
									<button className={cx("pa-chip", on && "!bg-accent-soft !text-accent")} onClick={() => put({ agentIds: on ? s.agentIds.filter((x) => x !== a.id) : [...s.agentIds, a.id] })}>
										{a.avatar} {a.name}
									</button>
									{on && s.enabled && (
										<Button size="sm" variant="ghost" disabled={busy === a.id} onClick={() => open(a.id)}>
											{busy === a.id ? <Loader2 size={14} className="animate-spin" /> : null} 打开微信
										</Button>
									)}
								</span>
							);
						})}
					</div>
					<div className="flex gap-2">
						<Button size="sm" variant="ghost" onClick={() => put({ enabled: !s.enabled })}>
							{s.enabled ? "关闭个人微信" : "重新开启"}
						</Button>
					</div>
					<p className="text-xs text-mut">登录：打开后在助理的「电脑」页（或手机上收到的接管通知）用这个小号扫码。助理只按你的要求发消息；给新的人发消息、发文件、转账/红包一律先问你。需要助理电脑（Docker）。</p>
				</>
			)}
			{msg && <div className="text-sm text-mut">{msg}</div>}
		</div>
	);
}

function Steps({ kind, open: init = false }: { kind: Kind; open?: boolean }) {
	const [open, setOpen] = useState(init);
	return (
		<div className="rounded-lg bg-hover p-3 text-sm">
			<button className="flex w-full items-center gap-1 font-medium" onClick={() => setOpen(!open)}>
				<ChevronDown size={14} className={cx("transition", !open && "-rotate-90")} /> 配置步骤（{KINDS[kind].mode}）
			</button>
			{open && (
				<ol className="mt-2 list-decimal space-y-1 pl-5 text-mut">
					{KINDS[kind].steps.map((s) => (
						<li key={s}>{s}</li>
					))}
				</ol>
			)}
		</div>
	);
}

function ChannelForm({ kind, agents, publicUrl, existing, onDone }: { kind: Kind; agents: { id: string; name: string; avatar: string }[]; publicUrl: string | null; existing?: Channel; onDone: () => void }) {
	const [vals, setVals] = useState<Record<string, string>>(existing?.config ?? {});
	const [name, setName] = useState(existing?.name ?? KINDS[kind].label);
	const [agentId, setAgentId] = useState(existing?.agentId ?? agents[0]?.id ?? "");
	const [err, setErr] = useState("");
	const [busy, setBusy] = useState(false);
	const save = async () => {
		setBusy(true);
		setErr("");
		const f = KINDS[kind].fields;
		const config = Object.fromEntries(f.filter((x) => !x.secret).map((x) => [x.key, vals[x.key] ?? ""]));
		const secret = Object.fromEntries(f.filter((x) => x.secret && vals[x.key]).map((x) => [x.key, vals[x.key]]));
		try {
			await api(existing ? `/api/channels/${existing.id}` : "/api/channels", { method: existing ? "PUT" : "POST", json: { kind, name, agentId, config, secret } });
			onDone();
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="space-y-3 rounded-xl border border-line p-4" data-testid="channel-form">
			<div className="font-semibold">{existing ? `编辑${KINDS[kind].label}` : `添加${KINDS[kind].label}`}</div>
			<Steps kind={kind} open={!existing} />
			{kind === "wecom" && !publicUrl && <div className="text-sm text-amber-600">还没有可用的公网地址：企业微信的回调需要先打开远程访问（推荐固定地址）。</div>}
			<div className="grid gap-2 sm:grid-cols-2">
				<label className="text-sm">
					名称
					<Input value={name} onChange={(e) => setName(e.target.value)} />
				</label>
				<label className="text-sm">
					消息交给哪个助理
					<select className="mt-1 h-10 w-full rounded-xl bg-zinc-100 px-3 outline-none dark:bg-zinc-800/80" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
						{agents.map((a) => (
							<option key={a.id} value={a.id}>
								{a.avatar} {a.name}
							</option>
						))}
					</select>
				</label>
				{KINDS[kind].fields.map((f) => (
					<label key={f.key} className="text-sm">
						{f.label}
						<Input type={f.secret ? "password" : "text"} placeholder={f.secret && existing?.secretsSet.includes(f.key) ? "已保存（留空不修改）" : f.placeholder} value={vals[f.key] ?? ""} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} data-testid={`ch-${f.key}`} />
					</label>
				))}
			</div>
			{err && <div className="text-sm text-red-600">{err}</div>}
			<div className="flex gap-2">
				<Button variant="primary" disabled={busy} onClick={save} data-testid="channel-save">
					{busy && <Loader2 size={14} className="animate-spin" />} 保存并连接
				</Button>
				<Button variant="ghost" onClick={onDone}>
					取消
				</Button>
			</div>
		</div>
	);
}

function ChannelCard({ c, publicUrl, agents, onChange }: { c: Channel; publicUrl: string | null; agents: { id: string; name: string; avatar: string }[]; onChange: () => void }) {
	const [edit, setEdit] = useState(false);
	const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
	const st = STATE[c.status.state] ?? STATE.off;
	const agent = agents.find((a) => a.id === c.agentId);
	const cb = c.callbackPath ? `${publicUrl ?? "<公网地址>"}${c.callbackPath}` : null;
	if (edit) return <ChannelForm kind={c.kind} agents={agents} publicUrl={publicUrl} existing={c} onDone={() => (setEdit(false), onChange())} />;
	return (
		<div className="space-y-3 rounded-xl border border-line p-4" data-testid={`channel-${c.kind}`}>
			<div className="flex items-center gap-2">
				<MessageSquare size={16} />
				<b>{c.name}</b>
				<Badge tone={st.tone}>{st.label}</Badge>
				<span className="truncate text-xs text-mut">{c.status.detail}</span>
				<span className="ml-auto text-xs text-mut">→ {agent ? `${agent.avatar} ${agent.name}` : "助理已删除"}</span>
			</div>
			{cb && (
				<div className="flex items-center gap-2 text-sm">
					<span className="shrink-0 text-mut">回调地址</span>
					<code className="min-w-0 flex-1 truncate rounded bg-hover px-2 py-1 text-xs" data-testid="wecom-callback">{cb}</code>
					<button className="pa-icon-btn ghost" aria-label="复制回调地址" onClick={() => navigator.clipboard?.writeText(cb)}>
						<Copy size={14} />
					</button>
				</div>
			)}
			<div className="flex items-center gap-2 text-sm">
				<span className="text-mut">绑定码</span>
				<code className="rounded bg-hover px-2 py-1 font-mono text-base tracking-widest" data-testid="bind-code">{c.bindCode}</code>
				<button className="pa-icon-btn ghost" title="换一个" aria-label="换一个绑定码" onClick={() => api(`/api/channels/${c.id}/bind-code`, { method: "POST" }).then(onChange)}>
					<RefreshCw size={14} />
				</button>
				<span className="text-xs text-mut">在{KINDS[c.kind].label}里发送「绑定 {c.bindCode}」（用一次就换）</span>
			</div>
			{c.users.length > 0 && (
				<ul className="space-y-1 text-sm">
					{c.users.map((u) => (
						<li key={u.id} className="flex items-center gap-2">
							{u.allowed ? <CheckCircle2 size={14} className="text-green-600" /> : <XCircle size={14} className="text-mut" />}
							<span>{u.display ?? u.id}</span>
							<span className="text-xs text-mut">{u.allowed ? "已绑定" : "未绑定"}</span>
							{u.allowed && (
								<button className="ml-auto text-xs text-red-600" onClick={() => api(`/api/channels/${c.id}/users/${encodeURIComponent(u.id)}`, { method: "PUT", json: { allowed: false } }).then(onChange)}>
									解除
								</button>
							)}
						</li>
					))}
				</ul>
			)}
			<Steps kind={c.kind} />
			<div className="flex flex-wrap items-center gap-2">
				<Button size="sm" onClick={() => api(`/api/channels/${c.id}/test`, { method: "POST" }).then(setTest)}>
					测试凭据
				</Button>
				<Button size="sm" variant="ghost" onClick={() => setEdit(true)}>
					编辑
				</Button>
				<Button size="sm" variant="ghost" onClick={() => api(`/api/channels/${c.id}`, { method: "PUT", json: { enabled: !c.enabled } }).then(onChange)}>
					{c.enabled ? "停用" : "启用"}
				</Button>
				<Button size="sm" variant="danger" onClick={() => confirm(`删除「${c.name}」？`) && api(`/api/channels/${c.id}`, { method: "DELETE" }).then(onChange)}>
					<Trash2 size={14} />
				</Button>
				{test && <span className={cx("text-sm", test.ok ? "text-green-600" : "text-red-600")}>{test.message}</span>}
			</div>
		</div>
	);
}
