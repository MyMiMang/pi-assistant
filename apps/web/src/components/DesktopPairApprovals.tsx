import { useState } from "react";
import { api } from "../api";
import { Button, ErrorBox } from "./ui";

type Request = { id: string; name: string; platform: string; checkCode: string | null; state: string; origin: string };

export function DesktopPairApprovals() {
	const [invite, setInvite] = useState<{ origin: string; serverId: string; publicKey: string; code: string; expires: number } | null>(null);
	const [requests, setRequests] = useState<Request[] | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const post = (op: "pending" | "approve" | "cancel", id?: string) => api<{ requests?: Request[]; ok?: boolean }>(`/api/desktop-edge-pair/${op}`, { method: "POST", json: id ? { id } : {} });
	const run = async (op?: "approve" | "cancel", id?: string) => {
		setBusy(true); setError("");
		try {
			if (op && !(await post(op, id)).ok) setError("申请已失效，请重新确认。");
			setRequests((await post("pending")).requests ?? []);
		} catch { setError("无法读取或处理桌面配对申请。"); }
		finally { setBusy(false); }
	};
	async function makeInvite() {
		setBusy(true); setError(""); setInvite(null);
		try { setInvite(await api<NonNullable<typeof invite>>("/api/desktop-edge-pair/invite", { method: "POST", json: {} })); }
		catch { setError("当前没有在线的固定 HTTPS 地址，无法生成桌面邀请。"); }
		finally { setBusy(false); }
	}
	return <section className="space-y-2">
		<h3 className="font-medium">桌面配对申请</h3>
		<p className="text-xs text-mut">把邀请单独交给要连接的电脑。请先核对对方显示的编号，再批准；手机配对照常。</p>
		<Button size="sm" variant="outline" disabled={busy} onClick={() => void makeInvite()}>生成桌面邀请</Button>
		{invite && <label className="block text-xs">{invite.origin} · 5 分钟内有效、仅用一次<textarea aria-label="桌面邀请" className="block w-full break-all" readOnly value={JSON.stringify(invite)} /></label>}
		<Button size="sm" variant="outline" disabled={busy} onClick={() => void run()}>查看申请</Button>
		<ErrorBox text={error} />
		{requests?.length === 0 && <p className="text-xs text-mut">暂无申请。</p>}
		{requests?.map(r => <div key={r.id} className="rounded-lg border border-line p-2 text-sm">
			<p className="break-all">{r.name} · {r.platform || "桌面电脑"}</p>
			<p className="break-all text-xs text-mut">{r.origin}{r.checkCode && ` · 核对编号 ${r.checkCode}`}</p>
			<div className="mt-1 flex gap-2">
				{r.state === "pending" ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void run("approve", r.id)}>核对后批准</Button> : <span className="text-xs text-mut">等待发起方确认</span>}
				<Button size="sm" variant="ghost" disabled={busy} onClick={() => void run("cancel", r.id)}>取消申请</Button>
			</div>
		</div>)}
	</section>;
}
