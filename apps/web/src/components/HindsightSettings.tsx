import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { Badge, Button, cx, Input } from "./ui";

type Emb = { kind: "local"; model: string } | { kind: "openai"; baseUrl: string; model: string; dimensions?: number };
type Rr = { kind: "local"; model: string } | { kind: "siliconflow"; model: string; baseUrl?: string } | { kind: "alibaba"; model: string } | { kind: "off" };
interface S {
	mode: "local" | "remote";
	remoteUrl?: string;
	llm: { provider: string; id: string } | null;
	embedding: Emb;
	reranker: Rr;
	mirror: "auto" | "official" | "china";
	embeddingKey: string;
	rerankerKey: string;
	remoteKey: string;
}
interface Data {
	settings: S;
	status: { state: string; detail: string; pending: number; lastError: string | null; restarts: number; mirror?: string; port?: number };
	inUse: boolean;
	models: { provider: string; id: string; name: string }[];
	autoModel: { provider: string; id: string } | null;
	effectiveModel: { provider: string; id: string } | null;
	localEmbeddings: { id: string; name: string }[];
	localRerankers: { id: string; name: string }[];
	usage: { requests: number; errors: number; input: number; output: number };
}
const EMB_PRESETS = [
	{ name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", model: "BAAI/bge-m3" },
	{ name: "阿里云百炼", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "text-embedding-v4" },
	{ name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small" },
];
const STATE: Record<string, { label: string; tone: "green" | "amber" | "red" | "zinc" }> = {
	ready: { label: "运行中", tone: "green" },
	installing: { label: "安装中", tone: "amber" },
	starting: { label: "启动中", tone: "amber" },
	down: { label: "无响应", tone: "red" },
	error: { label: "出错", tone: "red" },
	off: { label: "未启用", tone: "zinc" },
};
const key = (m: { provider: string; id: string } | null) => (m ? `${m.provider}/${m.id}` : "");

/** 设置 › 记忆 › 高级记忆（Hindsight）：运行方式、三个模型（记忆用 LLM / 向量 / 重排序）、下载源 */
export function HindsightSettings() {
	const version = useStore((s) => s.hindsightVersion);
	const [d, setD] = useState<Data | null>(null);
	const [s, setS] = useState<S | null>(null);
	const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
	const [testing, setTesting] = useState(false);
	const load = () =>
		api<Data>("/api/memory/hindsight").then((j) => {
			setD(j);
			setS((cur) => cur ?? j.settings);
		});
	useEffect(() => {
		void load();
	}, [version]);
	if (!d || !s) return null;
	const st = STATE[d.status.state] ?? STATE.off;
	const embChanged = JSON.stringify(s.embedding) !== JSON.stringify(d.settings.embedding);
	const dirty = JSON.stringify(s) !== JSON.stringify(d.settings);
	const save = async () => {
		setMsg(null);
		try {
			const r = await api("/api/memory/hindsight", { method: "PUT", json: s });
			setMsg({ ok: true, text: r.rebuild ? "已保存，正在用新的向量模型在后台重建记忆…" : r.restarting ? "已保存，Hindsight 正在重启…" : "已保存" });
			setS(null);
			await load();
		} catch (e) {
			setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
		}
	};
	const test = async () => {
		setTesting(true);
		const r = await api("/api/memory/hindsight/test-model", { method: "POST", json: { llm: s.llm } });
		setTesting(false);
		setMsg({ ok: r.ok, text: r.message });
	};
	const radio = (name: string, checked: boolean, onChange: () => void, label: React.ReactNode, testid?: string) => (
		<label className="flex cursor-pointer items-center gap-2 text-sm" data-testid={testid}>
			<input type="radio" name={name} checked={checked} onChange={onChange} />
			{label}
		</label>
	);
	return (
		<div className="pa-card space-y-4 !p-4" data-testid="hindsight-settings">
			<div className="flex items-center gap-2">
				<b className="text-sm">高级记忆（Hindsight）</b>
				<Badge tone={st.tone}>{st.label}</Badge>
				{d.status.state !== "off" && (
					<button className="pa-icon-btn ghost ml-auto" title="重启 Hindsight" aria-label="重启 Hindsight" onClick={() => void api("/api/memory/hindsight/restart", { method: "POST" })}>
						<RefreshCw className="pa-ic" />
					</button>
				)}
			</div>
			<p className="text-xs leading-relaxed text-mut">
				在本机单独运行（自带 Python 环境、数据库和数据目录，不碰你电脑上已有的 Python / Hindsight），自动整理事实、实体和时间线，支持“问问记忆”（反思）。首次启用会下载约 300–600 MB 运行环境和约 500 MB 模型，常驻内存约 1–1.5 GB。不可用时自动退回基础记忆，新记忆先排队，恢复后补写。
			</p>
			<div className={cx("text-xs", d.status.state === "error" || d.status.state === "down" ? "text-red-500" : "text-mut")} data-testid="hindsight-detail">
				{d.inUse ? d.status.detail : "还没有助理在用高级记忆：在上面选“高级记忆”或在助理的「记忆」页单独选择后自动安装并启动。"}
				{d.status.pending > 0 && ` · 待同步 ${d.status.pending} 条`}
				{d.status.lastError && d.status.pending > 0 && <div className="mt-1 opacity-80">最近错误：{d.status.lastError.slice(0, 200)}</div>}
			</div>

			<section className="space-y-2">
				<div className="text-xs font-medium text-mut">运行方式</div>
				<div className="flex flex-wrap gap-4">
					{radio("hs-mode", s.mode === "local", () => setS({ ...s, mode: "local" }), "本机运行（推荐）")}
					{radio("hs-mode", s.mode === "remote", () => setS({ ...s, mode: "remote" }), "连接远程 Hindsight")}
				</div>
				{s.mode === "remote" && (
					<div className="grid gap-2 sm:grid-cols-2">
						<Input placeholder="https://hindsight.example.com" value={s.remoteUrl ?? ""} onChange={(e) => setS({ ...s, remoteUrl: e.target.value })} />
						<Input placeholder="API Key" type="password" value={s.remoteKey} onChange={(e) => setS({ ...s, remoteKey: e.target.value })} />
					</div>
				)}
			</section>

			<section className="space-y-2">
				<div className="text-xs font-medium text-mut">① 记忆用模型（整理、反思时调用；建议选便宜快速的，与聊天模型分开）</div>
				<div className="flex gap-2">
					<select className="pa-input" aria-label="记忆用模型" value={key(s.llm)} onChange={(e) => setS({ ...s, llm: e.target.value ? d.models.find((m) => key(m) === e.target.value) ?? null : null })}>
						<option value="">自动（当前：{key(d.autoModel) || "无可用模型"}）</option>
						{d.models.map((m) => (
							<option key={key(m)} value={key(m)}>
								{m.provider} / {m.name || m.id}
							</option>
						))}
					</select>
					<Button variant="outline" disabled={testing} onClick={() => void test()}>
						{testing ? "测试中…" : "测试"}
					</Button>
				</div>
				<p className="text-xs text-mut">经本机网关调用你在「模型」里配置的渠道，密钥不会交给 Hindsight。已用 {d.usage.requests} 次，约 {d.usage.input + d.usage.output} tokens。</p>
			</section>

			<section className="space-y-2" data-testid="hs-embedding">
				<div className="text-xs font-medium text-mut">② 向量模型（决定“按意思找记忆”的效果）</div>
				{d.localEmbeddings.map((e) => radio("hs-emb", s.embedding.kind === "local" && s.embedding.model === e.id, () => setS({ ...s, embedding: { kind: "local", model: e.id } }), <>本地 · {e.name}</>))}
				{radio("hs-emb", s.embedding.kind === "openai", () => setS({ ...s, embedding: { kind: "openai", baseUrl: EMB_PRESETS[0].baseUrl, model: EMB_PRESETS[0].model } }), "在线（OpenAI 兼容接口）")}
				{s.embedding.kind === "openai" && (
					<div className="space-y-2 pl-6">
						<div className="flex flex-wrap gap-1">
							{EMB_PRESETS.map((p) => (
								<button key={p.name} className="pa-chip sm" onClick={() => setS({ ...s, embedding: { kind: "openai", baseUrl: p.baseUrl, model: p.model } })}>
									{p.name}
								</button>
							))}
						</div>
						<div className="grid gap-2 sm:grid-cols-2">
							<Input placeholder="接口地址" value={s.embedding.baseUrl} onChange={(e) => setS({ ...s, embedding: { ...(s.embedding as Emb & { kind: "openai" }), baseUrl: e.target.value } })} />
							<Input placeholder="模型名" value={s.embedding.model} onChange={(e) => setS({ ...s, embedding: { ...(s.embedding as Emb & { kind: "openai" }), model: e.target.value } })} />
							<Input placeholder="API Key" type="password" value={s.embeddingKey} onChange={(e) => setS({ ...s, embeddingKey: e.target.value })} />
							<Input placeholder="维度（可选）" inputMode="numeric" value={s.embedding.dimensions ?? ""} onChange={(e) => setS({ ...s, embedding: { ...(s.embedding as Emb & { kind: "openai" }), dimensions: Number(e.target.value) || undefined } })} />
						</div>
					</div>
				)}
				{embChanged && <p className="text-xs text-amber-600">更换向量模型后，会在后台用记忆原文重新生成全部向量（记忆不会丢）。</p>}
			</section>

			<section className="space-y-2" data-testid="hs-reranker">
				<div className="text-xs font-medium text-mut">③ 重排序（对找到的记忆再精排；关闭则只做多路融合）</div>
				<div className="flex flex-wrap gap-4">
					{radio("hs-rr", s.reranker.kind === "local", () => setS({ ...s, reranker: { kind: "local", model: d.localRerankers[0].id } }), "本地")}
					{radio("hs-rr", s.reranker.kind === "siliconflow", () => setS({ ...s, reranker: { kind: "siliconflow", model: "BAAI/bge-reranker-v2-m3" } }), "硅基流动")}
					{radio("hs-rr", s.reranker.kind === "alibaba", () => setS({ ...s, reranker: { kind: "alibaba", model: "qwen3-rerank" } }), "阿里云百炼")}
					{radio("hs-rr", s.reranker.kind === "off", () => setS({ ...s, reranker: { kind: "off" } }), "关闭", "hs-rr-off")}
				</div>
				{s.reranker.kind === "local" && (
					<select className="pa-input" aria-label="本地重排序模型" value={s.reranker.model} onChange={(e) => setS({ ...s, reranker: { kind: "local", model: e.target.value } })}>
						{d.localRerankers.map((r) => (
							<option key={r.id} value={r.id}>
								{r.name}
							</option>
						))}
					</select>
				)}
				{(s.reranker.kind === "siliconflow" || s.reranker.kind === "alibaba") && (
					<div className="grid gap-2 sm:grid-cols-2">
						<Input placeholder="模型名" value={s.reranker.model} onChange={(e) => setS({ ...s, reranker: { ...(s.reranker as Rr & { model: string }), model: e.target.value } as Rr })} />
						<Input placeholder="API Key" type="password" value={s.rerankerKey} onChange={(e) => setS({ ...s, rerankerKey: e.target.value })} />
					</div>
				)}
			</section>

			{s.mode === "local" && (
				<section className="space-y-2">
					<div className="text-xs font-medium text-mut">下载源（Python 依赖、模型）</div>
					<div className="flex flex-wrap gap-4">
						{radio("hs-mirror", s.mirror === "auto", () => setS({ ...s, mirror: "auto" }), "自动（官方源连不上就用国内镜像）")}
						{radio("hs-mirror", s.mirror === "official", () => setS({ ...s, mirror: "official" }), "官方源")}
						{radio("hs-mirror", s.mirror === "china", () => setS({ ...s, mirror: "china" }), "国内镜像（清华 PyPI / hf-mirror）")}
					</div>
				</section>
			)}

			<div className="flex items-center gap-3">
				<Button disabled={!dirty} onClick={() => void save()}>
					保存
				</Button>
				{dirty && (
					<Button variant="ghost" onClick={() => setS(d.settings)}>
						还原
					</Button>
				)}
				{msg && <span className={cx("text-xs", msg.ok ? "text-green-600" : "text-red-500")} data-testid="hs-msg">{msg.text}</span>}
			</div>
		</div>
	);
}
