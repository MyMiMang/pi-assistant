import { Loader2, Mail, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { Button, cx, Input, avatarText } from "./ui";

interface Server {
	host: string;
	port: number;
	secure: boolean;
}
interface Account {
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
			<p className="text-sm text-mut">给助理接上邮箱：它可以查看、搜索、阅读邮件，帮你写草稿。<b>发送前一定会先给你看完整的草稿并请你批准</b>。用邮箱的「授权码 / 应用专用密码」登录（不是登录密码），加密保存在这台电脑上。</p>
			{d.items.map((a) => (
				<div key={a.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line p-3 text-sm" data-testid="email-account">
					<Mail size={16} />
					<b>{a.address}</b>
					<span className="text-xs text-mut">
						{d.presets.find((p) => p.id === a.preset)?.label} · {a.agentId ? `仅 ${agents.find((x) => x.id === a.agentId)?.name ?? "（已删除的助理）"}` : "所有助理可用"}
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
					{preset && <div className="rounded-lg bg-hover p-3 text-sm text-mut">{preset.help}</div>}
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
