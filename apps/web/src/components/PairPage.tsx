import { CheckCircle2, Loader2, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";
import { saveConn } from "../api";
import { Button, Input } from "./ui";
import { BRAND } from "@pi-assistant/shared";

/** 手机扫码打开：#sid=&u=&pk=&c= → 认领配对码 → 等电脑确认 → 保存设备 token。 */
export default function PairPage() {
	const p = new URLSearchParams(location.hash.slice(1));
	const sid = p.get("sid") ?? "", u = p.get("u") ?? "", pk = p.get("pk") ?? "", code = p.get("c") ?? "";
	const ua = navigator.userAgent;
	const guess = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android 手机" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows 电脑" : "新设备";
	const [name, setName] = useState(guess);
	const [state, setState] = useState<"idle" | "claiming" | "waiting" | "done" | "error">("idle");
	const [err, setErr] = useState("");
	const base = u && u !== location.origin ? u : "";
	const [deviceId, setDeviceId] = useState("");

	const claim = async () => {
		setState("claiming");
		try {
			const r = await fetch(`${base}/api/pair/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name, platform: navigator.platform || "web" }) });
			const j = await r.json();
			if (!r.ok) throw new Error(j.error === "invalid_or_expired" ? "二维码已失效，请在电脑上重新生成" : j.error === "too_many_attempts" ? "尝试次数过多，请稍后再试" : j.error);
			setDeviceId(j.deviceId);
			setState("waiting");
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
			setState("error");
		}
	};
	useEffect(() => {
		if (state !== "waiting") return;
		const timer = setInterval(async () => {
			const r = await fetch(`${base}/api/pair/status/${deviceId}`).then((x) => x.json()).catch(() => null);
			if (r?.status === "active" && r.token) {
				clearInterval(timer);
				saveConn({ serverId: sid, base: u, token: r.token, publicKey: pk });
				history.replaceState(null, "", "/");
				setState("done");
				setTimeout(() => location.replace("/"), 1200);
			} else if (r?.status === "rejected") {
				clearInterval(timer);
				setErr("电脑端拒绝了这次配对");
				setState("error");
			}
		}, 2000);
		return () => clearInterval(timer);
	}, [state]);

	if (!sid || !code) return <div className="p-8 text-center text-sm">配对链接不完整，请重新扫码。</div>;
	return (
		<div className="flex min-h-full flex-col items-center justify-center gap-5 p-8 text-center">
			<img src="/icon-192.png" className="h-16 w-16 rounded-2xl shadow" alt="" />
			<h1 className="text-xl font-bold">连接到你的 {BRAND.name}</h1>
			{state === "idle" && (
				<div className="w-full max-w-xs space-y-3">
					<label className="block text-left text-xs text-zinc-500">给这台设备起个名字</label>
					<Input value={name} onChange={(e) => setName(e.target.value)} />
					<Button variant="primary" className="w-full" onClick={claim}>
						<Smartphone size={16} /> 连接
					</Button>
				</div>
			)}
			{(state === "claiming" || state === "waiting") && (
				<div className="flex flex-col items-center gap-2 text-sm text-zinc-500">
					<Loader2 className="animate-spin text-accent" />
					{state === "waiting" ? "请在电脑上点击「允许连接」" : "正在连接…"}
				</div>
			)}
			{state === "done" && (
				<div className="flex flex-col items-center gap-2 text-emerald-600">
					<CheckCircle2 size={32} /> 配对成功！
					<p className="max-w-xs text-xs text-zinc-500">提示：用浏览器“添加到主屏幕”，就能像 App 一样使用并接收通知。</p>
				</div>
			)}
			{state === "error" && (
				<div className="space-y-3">
					<div className="text-sm text-red-600">{err}</div>
					<Button variant="outline" onClick={() => setState("idle")}>
						重试
					</Button>
				</div>
			)}
		</div>
	);
}
