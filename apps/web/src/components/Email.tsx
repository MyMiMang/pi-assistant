import { Loader2, Mail, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { Button, cx, Help, Input, avatarText } from "./ui";

interface Server {
	host: string;
	port: number;
	secure: boolean;
}
interface Account {
	oauth?: boolean;
	id: string;
	agentId: string | null;
	name: string;
	address: string;
	preset: string;
	imap: Server;
	smtp: Server;
	user: string;
}
interface Preset {
	id: string;
	label: string;
	help: string;
	imap: Server;
	smtp: Server;
}

/** 设置 › 邮箱：助理可以读信、写草稿；每次发送都要你批准 */
export function EmailSettings() {
	const v = useStore((s) => s.channelsVersion);
	const agents = useStore((s) => s.agents);
	const [d, setD] = useState<{ items: Account[]; presets: Preset[] } | null>(null);
	const [form, setForm] = useState<{ preset: string; address: string; password: string; name: string; agentId: string; imapHost?: string; imapPort?: string; smtpHost?: string; smtpPort?: string } | null>(null);
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<Record<string, { ok: boolean; message: string }>>({});
	const [err, setErr] = useState("");
	const load = () => api("/api/email").then(setD);
	useEffect(() => void load(), [v]);
	if (!d) return null;
	const preset = d.presets.find((p) => p.id === form?.preset);
	const save = async () => {
		if (!form) return;
		setBusy(true);
		setErr("");
		try {
			const a = (await api("/api/email", {
				method: "POST",
				json: {
					preset: form.preset,
					address: form.address,
					password: form.password,
					name: form.name,
					agentId: form.agentId || null,
					...(form.preset === "custom" ? { imap: { host: form.imapHost, port: Number(form.imapPort || 993), secure: Number(form.imapPort || 993) === 993 }, smtp: { host: form.smtpHost, port: Number(form.smtpPort || 465), secure: Number(form.smtpPort || 465) === 465 } } : {}),
				},
			})) as Account;
			setForm(null);
			await load();
			setMsg((m) => ({ ...m, [a.id]: { ok: true, message: "正在测试连接…" } }));
			const r = await api(`/api/email/${a.id}/test`, { method: "POST" });
			setMsg((m) => ({ ...m, [a.id]: r }));
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="space-y-4" data-testid="email-settings">
			<p className="text-sm text-mut">
				助理可以读邮件、写草稿，<b>发送前一定先请你批准</b>。
				<Help className="ml-1">用邮箱的「授权码 / 应用专用密码」登录（不是登录密码），加密保存在这台电脑上。助理可以查看、搜索、阅读邮件，帮你写草稿；发送前会给你看完整草稿。</Help>
			</p>
			{d.items.map((a) => (
				<div key={a.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line p-3 text-sm" data-testid="email-account">
					<Mail size={16} />
					<b>{a.address}</b>
					<span className="text-xs text-mut">
						{d.presets.find((p) => p.id === a.preset)?.label}{a.oauth ? "（Google 登录）" : ""} · {a.agentId ? `仅 ${agents.find((x) => x.id === a.agentId)?.name ?? "（已删除的助理）"}` : "所有助理可用"}
					</span>
					<span className="ml-auto flex gap-2">
						<Button size="sm" onClick={() => api(`/api/email/${a.id}/test`, { method: "POST" }).then((r) => setMsg((m) => ({ ...m, [a.id]: r })))}>
							测试
						</Button>
						<Button size="sm" variant="danger" aria-label="删除邮箱" onClick={() => confirm(`删除 ${a.address}？`) && api(`/api/email/${a.id}`, { method: "DELETE" }).then(load)}>
							<Trash2 size={14} />
						</Button>
					</span>
					{msg[a.id] && <div className={cx("w-full text-xs", msg[a.id].ok ? "text-green-600" : "text-red-600")}>{msg[a.id].message}</div>}
				</div>
			))}
			{form ? (
				<div className="space-y-3 rounded-xl border border-line p-4" data-testid="email-form">
					<div className="flex flex-wrap gap-1.5">
						{d.presets.map((p) => (
							<button key={p.id} className={cx("pa-chip", form.preset === p.id && "!bg-accent-soft !text-accent")} onClick={() => setForm({ ...form, preset: p.id })}>
								{p.label}
							</button>
						))}
					</div>
					{form.preset === "gmail" && <GmailOAuth agentId={form.agentId || null} name={form.name} onDone={() => (setForm(null), void load())} />}
					{preset && <div className="rounded-lg bg-hover p-3 text-sm text-mut">{form.preset === "gmail" ? "或者用应用专用密码：" : ""}{preset.help}</div>}
					<div className="grid gap-2 sm:grid-cols-2">
						<label className="text-sm">
							邮箱地址
							<Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="name@qq.com" data-testid="email-address" />
						</label>
						<label className="text-sm">
							授权码 / 应用专用密码
							<Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} data-testid="email-password" />
						</label>
						<label className="text-sm">
							显示名（发件人名字）
							<Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="可选" />
						</label>
						<label className="text-sm">
							哪些助理可以用
							<select className="mt-1 h-10 w-full rounded-xl bg-zinc-100 px-3 outline-none dark:bg-zinc-800/80" value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })}>
								<option value="">所有助理</option>
								{agents.map((a) => (
									<option key={a.id} value={a.id}>
										仅 {avatarText(a.avatar)} {a.name}
									</option>
								))}
							</select>
						</label>
						{form.preset === "custom" && (
							<>
								<Input placeholder="IMAP 服务器" value={form.imapHost ?? ""} onChange={(e) => setForm({ ...form, imapHost: e.target.value })} />
								<Input placeholder="IMAP 端口（993）" value={form.imapPort ?? ""} onChange={(e) => setForm({ ...form, imapPort: e.target.value })} />
								<Input placeholder="SMTP 服务器" value={form.smtpHost ?? ""} onChange={(e) => setForm({ ...form, smtpHost: e.target.value })} />
								<Input placeholder="SMTP 端口（465）" value={form.smtpPort ?? ""} onChange={(e) => setForm({ ...form, smtpPort: e.target.value })} />
							</>
						)}
					</div>
					{err && <div className="text-sm text-red-600">{err}</div>}
					<div className="flex gap-2">
						<Button variant="primary" disabled={busy || !form.address || !form.password} onClick={save} data-testid="email-save">
							{busy && <Loader2 size={14} className="animate-spin" />} 保存并测试
						</Button>
						<Button variant="ghost" onClick={() => setForm(null)}>
							取消
						</Button>
					</div>
				</div>
			) : (
				<Button size="sm" onClick={() => setForm({ preset: "qq", address: "", password: "", name: "", agentId: "" })} data-testid="add-email">
					<Plus size={14} /> 添加邮箱
				</Button>
			)}
		</div>
	);
}

/** Gmail：用 Google 登录（OAuth，用户自己的 OAuth 客户端） */
function GmailOAuth({ agentId, name, onDone }: { agentId: string | null; name: string; onDone: () => void }) {
	const [g, setG] = useState<{ configured: boolean; clientId: string | null; redirectUri: string } | null>(null);
	const [cid, setCid] = useState("");
	const [sec, setSec] = useState("");
	const [err, setErr] = useState("");
	const [waiting, setWaiting] = useState(false);
	const load = () => api("/api/email/oauth/google").then(setG);
	useEffect(() => void load(), []);
	useEffect(() => {
		const h = (e: MessageEvent) => e.data?.type === "pia-oauth" && (setWaiting(false), e.data.ok && onDone());
		window.addEventListener("message", h);
		return () => window.removeEventListener("message", h);
	}, []);
	if (!g) return null;
	const start = async () => {
		setErr("");
		const r = await api("/api/email/oauth/google/start", { method: "POST", json: { agentId, name } }).catch((e) => ({ error: String(e) }));
		if (r.error) return setErr(r.error);
		setWaiting(true);
		window.open(r.url, "pia-google", "width=520,height=680");
	};
	return (
		<div className="space-y-2 rounded-lg border border-line p-3 text-sm" data-testid="gmail-oauth">
			<div className="font-semibold">用 Google 登录（推荐）</div>
			{g.configured ? (
				<>
					<div className="text-xs text-mut">OAuth 客户端：{g.clientId}（<button className="underline" onClick={() => api("/api/email/oauth/google", { method: "PUT", json: { clear: true } }).then(load)}>更换</button>）</div>
					<Button variant="primary" size="sm" onClick={start} data-testid="gmail-oauth-start">
						用 Google 登录
					</Button>
					{waiting && <div className="text-xs text-mut">在弹出的窗口里完成授权…（需要在这台电脑上操作）</div>}
				</>
			) : (
				<>
					<ol className="list-decimal space-y-1 pl-5 text-xs text-mut">
						<li>打开 console.cloud.google.com › 新建项目 › API 和服务 › 启用「Gmail API」。</li>
						<li>OAuth 权限请求页面：用户类型「外部」，把你的 Gmail 加为测试用户（或发布应用）。</li>
						<li>凭据 › 创建凭据 › OAuth 客户端 ID › 应用类型选「桌面应用」，复制 Client ID 和 Client Secret 填到下面。</li>
						<li>保存后点「用 Google 登录」，在弹出的 Google 页面里授权（范围：读写邮件，用于 IMAP/SMTP）。授权回到本机地址 {g.redirectUri}。</li>
					</ol>
					<div className="grid gap-2 sm:grid-cols-2">
						<Input value={cid} onChange={(e) => setCid(e.target.value)} placeholder="Client ID（….apps.googleusercontent.com）" data-testid="gmail-client-id" />
						<Input type="password" value={sec} onChange={(e) => setSec(e.target.value)} placeholder="Client Secret" data-testid="gmail-client-secret" />
					</div>
					<Button size="sm" disabled={!cid || !sec} onClick={async () => {
						const r = await api("/api/email/oauth/google", { method: "PUT", json: { clientId: cid, clientSecret: sec } }).catch((e) => ({ error: String(e) }));
						if (r.error) setErr(r.error);
						else void load();
					}} data-testid="gmail-client-save">
						保存
					</Button>
				</>
			)}
			{err && <div className="text-xs text-red-600">{err}</div>}
		</div>
	);
}
