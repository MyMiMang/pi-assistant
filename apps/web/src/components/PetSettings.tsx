/**
 * 设置 › 桌宠：开关、大小、跟随哪个助理、选宠物（内置 / 导入 / 孵化）、每个助理一只宠物。
 * 桌宠窗口本身在托盘程序里（/pet 页面），这里只改设置。
 */
import { Egg, Loader2, Play, Trash2, Upload, Wand2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { compose, cutout, loadImg, POSE_LABEL, POSES, type Pose } from "../pet/hatch";
import { type PetState, STATE_LABEL, STATE_ROW } from "../pet/atlas";
import { PetSprite } from "../pet/PetSprite";
import { readZip } from "../pet/zip";
import { useStore } from "../store";
import { Badge, Button, cx, Help, Input, useConfirm } from "./ui";

interface Pet {
	id: string;
	name: string;
	description: string;
	builtin: boolean;
	url: string;
	rows: number;
	prompt?: string;
}
interface Settings {
	enabled: boolean;
	follow: string;
	defaultPet: string;
	scale: number;
	quiet: boolean;
}
interface HatchInfo {
	model: { provider: string; model: string; label: string; edit: boolean } | null;
}

const H = ({ children, desc }: { children: React.ReactNode; desc?: React.ReactNode }) => (
	<div className="mb-3 flex min-w-0 items-center gap-1.5 font-semibold">
		<span className="min-w-0 truncate">{children}</span>
		{desc && <Help>{desc}</Help>}
	</div>
);
const PREVIEW_STATES: PetState[] = ["idle", "thinking", "working", "approval", "done", "error"];

export function PetSettings() {
	const agents = useStore((s) => s.agents).filter((a) => a.scope !== "room");
	const launcher = useStore((s) => s.system?.app?.launcher);
	const [pets, setPets] = useState<Pet[]>([]);
	const [s, setS] = useState<Settings | null>(null);
	const [petOf, setPetOf] = useState<Record<string, string>>({});
	const [preview, setPreview] = useState<PetState>("idle");
	const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
	const [dlg, ask] = useConfirm();
	const fileRef = useRef<HTMLInputElement>(null);

	const load = async () => {
		const r = await api<{ items: Pet[]; settings: Settings }>("/api/pets");
		setPets(r.items);
		setS(r.settings);
		const m: Record<string, string> = {};
		await Promise.all(agents.map(async (a) => (m[a.id] = (await api<{ pet: string }>(`/api/agents/${a.id}/pet`)).pet)));
		setPetOf(m);
	};
	useEffect(() => {
		void load().catch(() => {});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [agents.length]);
	if (!s) return <Loader2 className="animate-spin text-mut" size={18} />;

	const save = async (p: Partial<Settings>) => setS(await api<Settings>("/api/pet/settings", { method: "PUT", json: p }));
	const current = pets.find((p) => p.id === s.defaultPet) ?? pets[0];

	const importFiles = async (files: FileList | null) => {
		if (!files?.length) return;
		setMsg(null);
		try {
			let manifest: string | undefined;
			let sheet: Blob | undefined;
			for (const f of [...files]) {
				if (/\.zip$/i.test(f.name)) {
					const entries = await readZip(await f.arrayBuffer());
					for (const [name, data] of entries) {
						const base = name.split("/").pop()!;
						if (base === "pet.json") manifest = new TextDecoder().decode(data);
						else if (/\.(png|webp)$/i.test(base) && (!sheet || /spritesheet/i.test(base))) sheet = new Blob([data.slice()], { type: base.endsWith(".webp") ? "image/webp" : "image/png" });
					}
				} else if (/\.json$/i.test(f.name)) manifest = await f.text();
				else if (/\.(png|webp)$/i.test(f.name)) sheet = f;
			}
			if (!sheet) throw new Error("没找到精灵图（spritesheet.png / .webp）");
			const url = await new Promise<string>((res) => {
				const r = new FileReader();
				r.onload = () => res(String(r.result));
				r.readAsDataURL(sheet!);
			});
			const r = await api<{ ok: boolean; pet?: Pet; error?: string }>("/api/pets", { method: "POST", json: { sheet: url, manifest, name: manifest ? undefined : files[0].name.replace(/\.(zip|png|webp)$/i, "") } });
			if (!r.ok) throw new Error(r.error);
			setMsg({ ok: true, text: `已导入「${r.pet!.name}」` });
			await load();
		} catch (e) {
			setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
		} finally {
			if (fileRef.current) fileRef.current.value = "";
		}
	};
	const remove = async (p: Pet) => {
		if (!(await ask({ title: `删除「${p.name}」？`, body: "用这只宠物的助理会换回默认宠物。", ok: "删除", danger: true }))) return;
		await api(`/api/pets/${p.id}`, { method: "DELETE" });
		await load();
	};

	return (
		<div className="space-y-6" data-testid="pet-settings">
			{dlg}
			<section>
				<H desc="桌面上的小宠物，跟着助理的状态动：思考、干活、等你批准、做完、出错。单击和它说话，双击打开主窗口，按住拖动，右键有菜单。只在电脑版里显示。">桌宠</H>
				<label className="flex items-center gap-3 text-sm">
					<input type="checkbox" checked={s.enabled} onChange={(e) => save({ enabled: e.target.checked })} data-testid="pet-enabled" />
					在桌面上显示
				</label>
				{s.enabled && launcher && launcher !== "tray" && <p className="mt-2 text-xs text-mut2">现在不是从电脑版打开的，桌宠只在安装版的电脑程序里出现。可以先看 <a className="text-accent underline" href="/pet" target="_blank" rel="noreferrer">预览</a>。</p>}
				<div className="mt-4 grid gap-4 sm:grid-cols-2">
					<label className="text-sm">
						<span className="mb-1 flex items-center gap-1 text-mut">
							跟随
							<Help>「自动」会跟着最需要你关注的助理：先是等你批准的，再是正在干活的，最后是最近聊过的。</Help>
						</span>
						<select className="pa-input h-9 w-full rounded-lg border border-line bg-card px-2" value={s.follow} onChange={(e) => save({ follow: e.target.value })} data-testid="pet-follow">
							<option value="auto">自动</option>
							{agents.map((a) => (
								<option key={a.id} value={a.id}>
									{a.name}
								</option>
							))}
						</select>
					</label>
					<label className="text-sm">
						<span className="mb-1 block text-mut">大小 {Math.round(s.scale * 100)}%</span>
						<input type="range" min={0.6} max={1.4} step={0.1} value={s.scale} onChange={(e) => save({ scale: Number(e.target.value) })} className="w-full" data-testid="pet-scale" />
					</label>
				</div>
				<label className="mt-3 flex items-center gap-3 text-sm">
					<input type="checkbox" checked={s.quiet} onChange={(e) => save({ quiet: e.target.checked })} />
					安静模式
					<Help>不冒「做完了」「出错了」的气泡，只做动作。等你批准的提醒照常显示。</Help>
				</label>
			</section>

			<section>
				<H desc="点一只设为默认宠物。还可以导入 Codex 格式的宠物包（pet.json + 精灵图，或打包成 zip），或者用图片模型孵化一只。">宠物</H>
				{current && (
					<div className="mb-4 flex flex-col items-center gap-3 rounded-2xl border border-line bg-[color-mix(in_srgb,var(--accent)_5%,var(--card))] p-4 sm:flex-row" data-testid="pet-preview">
						<PetSprite url={current.url} row={STATE_ROW[preview]} scale={0.9} />
						<div className="min-w-0 flex-1">
							<div className="font-semibold">{current.name}</div>
							<div className="mb-3 text-xs text-mut">{current.description}</div>
							<div className="flex flex-wrap gap-1.5">
								{PREVIEW_STATES.map((st) => (
									<button key={st} onClick={() => setPreview(st)} className={cx("h-7 rounded-full border px-2.5 text-xs", preview === st ? "border-accent bg-accent-soft text-accent" : "border-line text-mut hover:bg-hover")}>
										{STATE_LABEL[st]}
									</button>
								))}
							</div>
						</div>
					</div>
				)}
				<div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5" role="radiogroup" aria-label="默认宠物">
					{pets.map((p) => (
						<div key={p.id} className="group relative">
							<button
								role="radio"
								aria-checked={p.id === s.defaultPet}
								data-pet={p.id}
								onClick={() => save({ defaultPet: p.id })}
								className={cx("flex w-full flex-col items-center rounded-xl border p-1.5 pb-2 transition", p.id === s.defaultPet ? "border-accent ring-2 ring-accent/30" : "border-line hover:border-zinc-400")}
							>
								<PetSprite url={p.url} row="idle" scale={0.42} />
								<span className="mt-1 max-w-full truncate text-xs font-medium">{p.name}</span>
							</button>
							{!p.builtin && (
								<button className="absolute top-1 right-1 hidden rounded-md bg-card/90 p-1 text-mut shadow group-hover:block hover:text-red-500" aria-label={`删除 ${p.name}`} onClick={() => remove(p)}>
									<Trash2 size={13} />
								</button>
							)}
						</div>
					))}
				</div>
				<div className="mt-3 flex flex-wrap items-center gap-2">
					<input ref={fileRef} type="file" hidden multiple accept=".zip,.png,.webp,.json" onChange={(e) => importFiles(e.target.files)} data-testid="pet-import-file" />
					<Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
						<Upload size={14} /> 导入宠物包
					</Button>
					<Help>支持 Codex 宠物格式：zip，或者同时选 pet.json 和精灵图。精灵图要是 1536×1872（v1）或 1536×2288（v2）的透明 PNG / WebP。</Help>
					{msg && <span className={cx("text-xs", msg.ok ? "text-green-600" : "text-red-500")}>{msg.text}</span>}
				</div>
			</section>

			<Hatch onDone={load} />

			{agents.length > 1 && (
				<section>
					<H desc="每个助理可以有自己的宠物；桌宠跟着谁，就显示谁的宠物。">每个助理的宠物</H>
					<details className="rounded-xl border border-line" data-testid="pet-per-agent">
						<summary className="cursor-pointer px-3 py-2 text-sm">
							{agents.length} 个助理 <span className="text-xs text-mut">· {agents.filter((a) => petOf[a.id] && petOf[a.id] !== s.defaultPet).length} 个用了别的宠物</span>
						</summary>
					<div className="max-h-64 divide-y divide-line overflow-y-auto border-t border-line">
						{agents.map((a) => (
							<div key={a.id} className="flex items-center gap-3 px-3 py-2 text-sm">
								<span className="min-w-0 flex-1 truncate">{a.name}</span>
								<select
									className="h-8 rounded-lg border border-line bg-card px-2 text-sm"
									value={petOf[a.id] ?? s.defaultPet}
									onChange={async (e) => {
										await api(`/api/agents/${a.id}/pet`, { method: "PUT", json: { pet: e.target.value } });
										setPetOf({ ...petOf, [a.id]: e.target.value });
									}}
									aria-label={`${a.name} 的宠物`}
								>
									{pets.map((p) => (
										<option key={p.id} value={p.id}>
											{p.name}
										</option>
									))}
								</select>
							</div>
						))}
					</div>
					</details>
				</section>
			)}
		</div>
	);
}

type Step = { pose: Pose; status: "wait" | "run" | "ok" | "fallback" | "error"; img?: string };

function Hatch({ onDone }: { onDone: () => void }) {
	const [info, setInfo] = useState<HatchInfo | null>(null);
	const [desc, setDesc] = useState("");
	const [name, setName] = useState("");
	const [steps, setSteps] = useState<Step[] | null>(null);
	const [sheet, setSheet] = useState<string | null>(null);
	const [err, setErr] = useState("");
	const [running, setRunning] = useState(false);
	const [saved, setSaved] = useState("");
	const abort = useRef<AbortController | null>(null);
	const set = useStore((s) => s.set);
	useEffect(() => {
		void api<HatchInfo>("/api/pets/hatch").then(setInfo).catch(() => {});
	}, []);

	const run = async () => {
		setErr("");
		setSaved("");
		setSheet(null);
		setRunning(true);
		const ctl = new AbortController();
		abort.current = ctl;
		const st: Step[] = POSES.map((p) => ({ pose: p, status: "wait" }));
		setSteps([...st]);
		const cut: Partial<Record<Pose, HTMLCanvasElement>> = {};
		let reference: string | undefined;
		try {
			for (let i = 0; i < POSES.length; i++) {
				const pose = POSES[i];
				st[i] = { ...st[i], status: "run" };
				setSteps([...st]);
				let ok = false;
				for (let attempt = 0; attempt < 2 && !ok; attempt++) {
					const r = await api<{ ok: boolean; image?: string; error?: string; code?: string }>("/api/pets/hatch/pose", { method: "POST", json: { description: desc, pose, reference }, signal: ctl.signal }).catch((e) => {
						if (ctl.signal.aborted) throw new Error("已取消");
						return { ok: false, error: e instanceof Error ? e.message : String(e), code: undefined, image: undefined };
					});
					if (!r.ok || !r.image) {
						if (pose === "base" && attempt === 1) throw new Error(r.error || "定妆图生成失败");
						if (r.code === "auth" || r.code === "quota" || r.code === "policy") {
							if (pose === "base") throw new Error(r.error);
							break;
						}
						continue;
					}
					try {
						const c = cutout(await loadImg(r.image));
						cut[pose] = c;
						st[i] = { pose, status: "ok", img: c.toDataURL("image/png") };
						ok = true;
						if (pose === "base") reference = r.image;
					} catch (e) {
						if (pose === "base" && attempt === 1) throw new Error(`定妆图处理失败：${e instanceof Error ? e.message : e}，换个描述再试`);
					}
				}
				// 其他姿势失败就用定妆图代替（动作照样有，只是表情不变）
				if (!ok) st[i] = { pose, status: "fallback", img: st[0].img };
				setSteps([...st]);
			}
			setSheet(compose(cut));
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
			const k = st.findIndex((x) => x.status === "run");
			if (k >= 0) st[k] = { ...st[k], status: "error" };
			setSteps([...st]);
		} finally {
			setRunning(false);
			abort.current = null;
		}
	};
	const keep = async () => {
		if (!sheet) return;
		const r = await api<{ ok: boolean; pet?: { id: string; name: string }; error?: string }>("/api/pets", { method: "POST", json: { sheet, name: name.trim() || desc.trim().slice(0, 12), description: desc.trim().slice(0, 100), prompt: desc } }).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e), pet: undefined }));
		if (!r.ok) return setErr(r.error ?? "保存失败");
		await api("/api/pet/settings", { method: "PUT", json: { defaultPet: r.pet!.id } });
		setSaved(`「${r.pet!.name}」孵化好了，已设为默认宠物`);
		setSheet(null);
		setSteps(null);
		onDone();
	};

	return (
		<section data-testid="pet-hatch">
			<H desc="用一句话描述你想要的宠物，App 会用你配置的图片生成模型画 6 个姿势，自动去背景、做成整套动画。大约要调用 6 次图片模型，会按服务商价格扣费。">孵化新宠物</H>
			{!info ? null : !info.model ? (
				<div className="rounded-xl border border-dashed border-line p-4 text-sm" data-testid="pet-hatch-nomodel">
					<div className="mb-2 flex items-center gap-2 font-medium">
						<Egg size={16} className="text-mut" /> 还没有图片生成模型
					</div>
					<p className="mb-3 text-mut">孵化要用图片模型画宠物。先接一个（OpenAI 兼容、通义万相、豆包 Seedream、Gemini、Grok 都行）。</p>
					<Button size="sm" variant="outline" onClick={() => set({ settings: "models" })}>
						去 设置 › 模型 › 图片生成
					</Button>
				</div>
			) : (
				<div className="space-y-3">
					<div className="flex flex-col gap-2 sm:flex-row">
						<div className="min-w-0 flex-1">
							<Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="一句话描述，例如：戴草帽的小柴犬" maxLength={200} disabled={running} data-testid="pet-hatch-desc" className="w-full" />
						</div>
						<div className="sm:w-36">
							<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="名字（可选）" maxLength={20} disabled={running} className="w-full" />
						</div>
						{running ? (
							<Button variant="outline" onClick={() => abort.current?.abort()}>
								<X size={15} /> 取消
							</Button>
						) : (
							<Button variant="primary" disabled={!desc.trim()} onClick={run} data-testid="pet-hatch-go">
								<Wand2 size={15} /> 孵化
							</Button>
						)}
					</div>
					<div className="flex items-center gap-1.5 text-xs text-mut2">
						用 <Badge>{info.model.label}</Badge>
						{!info.model.edit && <Help>这个模型不支持参考图，6 个姿势分别画，角色样子可能不太一致。用支持改图的模型（如 gpt-image-1、Seedream 4、Gemini 图片模型）效果更好。</Help>}
					</div>
					{steps && (
						<div className="grid grid-cols-3 gap-2 sm:grid-cols-6" data-testid="pet-hatch-steps">
							{steps.map((x) => (
								<div key={x.pose} className={cx("flex aspect-square flex-col items-center justify-center rounded-xl border text-xs", x.status === "error" ? "border-red-300" : "border-line")}>
									{x.img ? <img src={x.img} alt="" className="h-3/4 w-3/4 object-contain" /> : x.status === "run" ? <Loader2 size={18} className="animate-spin text-accent" /> : <span className="text-mut2">…</span>}
									<span className={cx("mt-1", x.status === "fallback" ? "text-amber-600" : "text-mut")} title={x.status === "fallback" ? "这一张没画成，先用定妆图代替" : undefined}>
										{POSE_LABEL[x.pose]}
										{x.status === "fallback" && " ⚠"}
									</span>
								</div>
							))}
						</div>
					)}
					{err && <p className="text-sm text-red-500">{err}</p>}
					{saved && <p className="text-sm text-green-600">{saved}</p>}
					{sheet && (
						<div className="flex flex-col items-center gap-3 rounded-2xl border border-line p-4 sm:flex-row" data-testid="pet-hatch-result">
							<HatchPreview url={sheet} />
							<div className="flex flex-1 flex-wrap gap-2 sm:justify-end">
								<Button variant="primary" onClick={keep} data-testid="pet-hatch-keep">
									<Egg size={15} /> 就要它
								</Button>
								<Button variant="outline" onClick={run}>
									<Play size={15} /> 重新孵化
								</Button>
							</div>
						</div>
					)}
				</div>
			)}
		</section>
	);
}

function HatchPreview({ url }: { url: string }) {
	const [st, setSt] = useState<PetState>("idle");
	useEffect(() => {
		const order: PetState[] = ["idle", "thinking", "working", "approval", "done", "error"];
		const t = setInterval(() => setSt((s) => order[(order.indexOf(s) + 1) % order.length]), 2200);
		return () => clearInterval(t);
	}, []);
	return (
		<div className="flex flex-col items-center">
			<PetSprite url={url} row={STATE_ROW[st]} scale={0.8} />
			<span className="text-xs text-mut">{STATE_LABEL[st]}</span>
		</div>
	);
}
