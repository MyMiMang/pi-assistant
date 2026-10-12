import { CheckCircle2, KeyRound, Loader2, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";
import { saveConn } from "../api";
import { Button, Input } from "./ui";
import { BRAND } from "@pi-assistant/shared";

type Target = { sid: string; u: string; pk: string; code: string };
type State = "idle" | "claiming" | "waiting" | "done" | "error";

const parseHash = (hash: string): Target | null => {
	const p = new URLSearchParams(hash.replace(/^#/, ""));
	const t = { sid: p.get("sid") ?? "", u: p.get("u") ?? "", pk: p.get("pk") ?? "", code: p.get("c") ?? "" };
	return t.sid && t.code ? t : null;
};
/** 输入框里的内容：完整配对链接（…/pair#sid=…&c=…）或电脑上显示的短码（ABCD-EFGH）。 */
export function parsePairInput(raw: string): { link: Target } | { short: string } | null {
	const s = raw.trim();
	const i = s.indexOf("#");
	if (i >= 0 && /sid=/.test(s)) {
		const t = parseHash(s.slice(i));
		return t ? { link: t } : null;
	}
	const short = s.toUpperCase().replace(/[\s\-_.]/g, "");
	return /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{8}$/.test(short) ? { short } : null;
}
/** iOS 主屏 App / 安卓已安装 PWA：和浏览器不共享登录信息。 */
export const isStandalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const guessName = () => {
	const ua = navigator.userAgent;
	return /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android 手机" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows 电脑" : "新设备";
};
const errText = (e: string) =>
	e === "invalid_or_expired" ? "配对码不对或已失效，请在电脑上重新生成" : e === "too_many_attempts" ? "错误次数太多，已暂时锁定，请 15 分钟后在电脑上重新生成配对码" : e === "rate_limited" ? "尝试太频繁，请稍等一分钟再试" : e;

/** 认领配对码 → （需要时）等电脑确认 → 保存设备 token。扫码链接和手输配对码共用。 */
function usePairing() {
	const [state, setState] = useState<State>("idle");
	const [err, setErr] = useState("");
	const [pending, setPending] = useState<{ base: string; deviceId: string; conn: { serverId: string; base: string; publicKey: string } } | null>(null);
	const fail = (e: unknown) => (setErr(e instanceof Error ? e.message : String(e)), setState("error"));
	const claim = async (input: { link: Target } | { short: string }, name: string) => {
		setState("claiming");
		setErr("");
		try {
			let base = "", code: string, sid = "", u = "", pk = "";
			if ("link" in input) {
				({ sid, u, pk, code } = input.link);
				base = u && u !== location.origin ? u : "";
			} else {
				code = input.short;
				// 短码只能在“服务本身的地址”上用（固定地址 / 隧道 / 本机）；从这个地址拿服务身份
				const pub = await fetch("/api/system/public").then((r) => (r.ok ? r.json() : null)).catch(() => null);
				if (!pub?.serverId) throw new Error("这个地址不能直接用配对码，请改为粘贴完整配对链接");
				({ serverId: sid, publicKey: pk } = pub);
				u = location.origin;
			}
			const r = await fetch(`${base}/api/pair/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name, platform: navigator.platform || "web" }) });
			const j = await r.json().catch(() => ({}));
			if (!r.ok) throw new Error(errText(j.error ?? r.statusText));
			setPending({ base, deviceId: j.deviceId, conn: { serverId: sid || j.serverId, base: u, publicKey: pk || j.publicKey } });
			setState("waiting");
		} catch (e) {
			fail(e);
		}
	};
	useEffect(() => {
		if (state !== "waiting" || !pending) return;
		let stop = false;
		const tick = async () => {
			const r = await fetch(`${pending.base}/api/pair/status/${pending.deviceId}`).then((x) => x.json()).catch(() => null);
			if (stop) return;
			if (r?.status === "active" && r.token) {
				saveConn({ ...pending.conn, token: r.token });
				history.replaceState(null, "", "/");
				setState("done");
				return;
			}
			if (r?.status === "rejected") return fail("电脑端拒绝了这次配对");
			setTimeout(tick, 1500);
		};
		void tick();
		return () => void (stop = true);
	}, [state, pending]);
	return { state, err, claim, reset: () => setState("idle") };
}

function Done() {
	const standalone = isStandalone();
	useEffect(() => {
		// 已经在主屏 App 里：直接进去；在浏览器里：先看清楚提示再进
		if (standalone) setTimeout(() => location.replace("/"), 1000);
	}, [standalone]);
	return (
		<div className="flex flex-col items-center gap-3 text-emerald-600" data-testid="pair-done">
			<CheckCircle2 size={32} /> 配对成功！
			{!standalone && (
				<div className="max-w-xs space-y-1 rounded-xl bg-zinc-50 p-3 text-left text-xs leading-relaxed text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-300" data-testid="pair-a2hs-hint">
					<div className="font-medium">想像 App 一样用、收通知？</div>
					{isIOS() ? "点 Safari 底部的「分享」→「添加到主屏幕」。" : "在浏览器菜单里选「添加到主屏幕 / 安装应用」。"}
					<div>
						注意：{isIOS() ? "iPhone 上" : "有些手机上"}主屏 App 和浏览器不共享登录，第一次打开会提示“还没有配对”——在电脑上「设置 → 远程访问与设备」重新生成一次，在 App 里输入屏幕上的<b>配对码</b>即可（只需一次）。
					</div>
				</div>
			)}
			{!standalone && (
				<Button variant="primary" onClick={() => location.replace("/")}>
					开始使用
				</Button>
			)}
		</div>
	);
}

/** 手输配对码 / 粘贴配对链接。主屏 App 未配对时、或 /pair 没带链接参数时显示。 */
export function PairCodeForm({ autoFocus }: { autoFocus?: boolean }) {
	const [value, setValue] = useState("");
	const [name, setName] = useState(guessName);
	const { state, err, claim, reset } = usePairing();
	const parsed = parsePairInput(value);
	if (state === "done") return <Done />;
	if (state === "claiming" || state === "waiting")
		return (
			<div className="flex flex-col items-center gap-2 text-sm text-zinc-500">
				<Loader2 className="animate-spin text-accent" />
				{state === "waiting" ? "请在电脑上点击「允许连接」" : "正在连接…"}
			</div>
		);
	return (
		<form className="w-full max-w-xs space-y-3 text-left" data-testid="pair-code-form" onSubmit={(e) => (e.preventDefault(), parsed && void claim(parsed, name))}>
			<label className="block space-y-1">
				<span className="text-xs text-zinc-500">配对码（电脑上「设置 → 远程访问与设备」生成），或粘贴完整配对链接</span>
				<Input
					data-testid="pair-code-input"
					value={value}
					onChange={(e) => (setValue(e.target.value), state === "error" && reset())}
					placeholder="ABCD-EFGH"
					autoFocus={autoFocus}
					autoCapitalize="characters"
					autoCorrect="off"
					autoComplete="one-time-code"
					spellCheck={false}
					className="text-center font-mono text-lg tracking-widest"
				/>
			</label>
			<label className="block space-y-1">
				<span className="text-xs text-zinc-500">给这台设备起个名字</span>
				<Input value={name} onChange={(e) => setName(e.target.value)} />
			</label>
			{value.trim() && !parsed && <div className="text-xs text-amber-600">配对码是 8 位字母数字（如 ABCD-EFGH），或者以 …/pair#sid= 开头的链接</div>}
			{state === "error" && <div className="text-sm text-red-600">{err}</div>}
			<Button type="submit" variant="primary" className="w-full" disabled={!parsed} data-testid="pair-code-submit">
				<KeyRound size={16} /> 用配对码连接
			</Button>
		</form>
	);
}

/** 手机扫码打开：#sid=&u=&pk=&c= → 认领配对码 → 等电脑确认 → 保存设备 token。没带参数时可以手输配对码。 */
export default function PairPage() {
	const [target] = useState(() => parseHash(location.hash)); // 只在打开时读一次（配对成功后地址会被改成 /）
	const [name, setName] = useState(guessName);
	const { state, err, claim, reset } = usePairing();
	return (
		<div className="flex min-h-full flex-col items-center justify-center gap-5 p-8 text-center">
			<img src="/icon-192.png" className="h-16 w-16 rounded-2xl" alt="" />
			<h1 className="text-xl font-bold">连接到你的 {BRAND.name}</h1>
			{!target ? (
				<PairCodeForm autoFocus />
			) : (
				<>
					{state === "idle" && (
						<div className="w-full max-w-xs space-y-3">
							<label className="block text-left text-xs text-zinc-500">给这台设备起个名字</label>
							<Input value={name} onChange={(e) => setName(e.target.value)} />
							<Button variant="primary" className="w-full" onClick={() => void claim({ link: target }, name)}>
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
					{state === "done" && <Done />}
					{state === "error" && (
						<div className="space-y-3">
							<div className="text-sm text-red-600">{err}</div>
							<Button variant="outline" onClick={reset}>
								重试
							</Button>
							<div className="pt-2 text-xs text-zinc-500">或者输入电脑上新生成的配对码：</div>
							<PairCodeForm />
						</div>
					)}
				</>
			)}
		</div>
	);
}
