import { THINKING_LEVEL_ORDER } from "@pi-assistant/shared";
import { THINKING_LABEL } from "../thinking-slider";
import type { CustomProviderMeta, RelayCapabilityFacts, RelayCapabilityScope } from "../types";
import { Button, Help, Input, Select } from "./ui";

export type ScopeDraft = Omit<RelayCapabilityScope, "appliesTo" | "exceptions"> & {
	allChat: boolean;
	ids: string;
	exceptions: [string, RelayCapabilityFacts][];
};

export function scopeDraft(scope?: RelayCapabilityScope): ScopeDraft | null {
	if (!scope) return null;
	const { appliesTo, exceptions, ...binding } = scope;
	return { ...binding, allChat: appliesTo === "all-chat", ids: appliesTo === "all-chat" ? "" : appliesTo.join("\n"), exceptions: Object.entries(exceptions ?? {}) };
}

export function scopePayload(draft: ScopeDraft): RelayCapabilityScope {
	const { allChat, ids, exceptions, source, baseUrl, ...binding } = draft;
	const idList = [...new Set(ids.split(/[\n,]/).map((id) => id.trim()).filter(Boolean))];
	const exact = exceptions.map(([id, facts]) => [id.trim(), facts] as const);
	if (!source.trim()) throw new Error("请填写渠道文档链接或说明。");
	if (!/^https?:\/\//.test(baseUrl.trim())) throw new Error("请填写该协议的实际请求地址。");
	if (!allChat && !idList.length) throw new Error("请填写至少一个完整模型 ID。");
	if (exact.some(([id]) => !id || (!allChat && !idList.includes(id))) || new Set(exact.map(([id]) => id)).size !== exact.length) throw new Error("例外必须使用适用范围内的完整模型 ID，不能重复。");
	const cleanFacts = (facts: RelayCapabilityFacts): RelayCapabilityFacts => {
		if (!facts.levels) return facts;
		const levels = Object.fromEntries(Object.entries(facts.levels).map(([level, value]) => [level, value?.trim() ?? null]));
		if (Object.values(levels).includes("")) throw new Error("请填写所选思考档位的协议值，或取消该档位声明。");
		return { ...facts, levels };
	};
	return { ...binding, defaults: cleanFacts(binding.defaults), source: source.trim(), baseUrl: baseUrl.trim().replace(/\/+$/, ""), appliesTo: allChat ? "all-chat" : idList, ...(exact.length ? { exceptions: Object.fromEntries(exact.map(([id, facts]) => [id, cleanFacts(facts)])) } : {}) };
}

function Facts({ facts, onChange }: { facts: RelayCapabilityFacts; onChange: (facts: RelayCapabilityFacts) => void }) {
	const levels = facts.levels ?? {};
	const setLevel = (level: string, value?: string | null) => {
		const next = { ...levels };
		if (value === undefined) delete next[level];
		else next[level] = value;
		onChange({ ...facts, levels: Object.keys(next).length ? next : undefined });
	};
	const off = levels.off === undefined ? "unknown" : levels.off === null ? "omit" : "value";
	return <div className="space-y-2">
		<div className="grid grid-cols-2 gap-2">
			{([["vision", "识图"], ["reasoning", "思考"]] as const).map(([key, label]) => <div key={key} className="min-w-0 space-y-1">
				<p className="text-xs text-mut">{label}</p>
				<Select value={String(facts[key] ?? "unset")} ariaLabel={label} options={[{ value: "unset", label: "不声明" }, { value: "true", label: "支持" }, { value: "false", label: "不支持" }]} onChange={(v) => onChange({ ...facts, [key]: v === "unset" ? undefined : v === "true" })} />
			</div>)}
		</div>
		<details>
			<summary className="cursor-pointer text-xs">思考档位协议值{Object.keys(levels).length ? `（${Object.keys(levels).length} 项）` : ""}</summary>
			<p className="my-1 text-xs text-mut">只填写文档明确的值。例外如填写档位，整组替换默认档位。</p>
			<div className="grid gap-2 sm:grid-cols-2">
				{THINKING_LEVEL_ORDER.filter((level) => level !== "off").map((level) => <Input key={level} aria-label={`${THINKING_LABEL[level]}档协议值`} placeholder={`${THINKING_LABEL[level]}档（未声明）`} value={levels[level] ?? ""} onChange={(e) => setLevel(level, e.target.value || undefined)} />)}
				<Select value={off} ariaLabel="关闭语义" options={[{ value: "unknown", label: "关闭：不声明" }, { value: "omit", label: "关闭：仅省略参数" }, { value: "value", label: "关闭：发送协议值" }]} onChange={(v) => setLevel("off", v === "omit" ? null : v === "value" ? "" : undefined)} />
				{off === "value" && <Input aria-label="关闭档协议值" placeholder="关闭档协议值" value={levels.off ?? ""} onChange={(e) => setLevel("off", e.target.value)} />}
			</div>
		</details>
	</div>;
}

export function RelayCapabilityScopeFields({ draft, onChange, meta, endpoint, error }: { draft: ScopeDraft | null; onChange: (draft: ScopeDraft | null) => void; meta: CustomProviderMeta; endpoint?: string; error: string }) {
	const api = meta.api === "auto" ? "openai-completions" : meta.api;
	const canAdd = api === "openai-completions" || api === "openai-responses";
	const boundUrl = meta.api === "auto" ? endpoint?.trim() || meta.models.find((m) => m.apiEffective === api)?.baseUrlEffective || "" : meta.baseUrl;
	return <div className="space-y-2 border-t border-line px-3 py-3" data-testid="relay-capability-scope">
		<div className="flex flex-wrap items-center gap-1.5">
			<span className="text-sm font-medium">渠道能力范围</span>
			<Help>只对这里记录的协议和实际请求地址生效，切换连接不会沿用。仅在渠道文档明确保证时选全部对话模型；否则用完整 ID。</Help>
			{(draft || canAdd) && <Button className="ml-auto" size="sm" variant="ghost" onClick={() => onChange(draft ? null : { api, baseUrl: boundUrl, source: "", allChat: false, ids: "", defaults: {}, exceptions: [] })}>{draft ? "清除范围" : "添加范围"}</Button>}
		</div>
		<p className="text-xs text-mut">按渠道文档一次声明识图和思考能力，范围内的新模型也能继承。</p>
		{draft && <>
			<div className="space-y-1">
				<p className="text-xs text-mut">协议：{draft.api === "openai-responses" ? "OpenAI Responses" : "OpenAI Chat Completions"}</p>
				<label className="block space-y-1 text-xs text-mut"><span>范围绑定地址</span><Input placeholder="该协议的实际请求地址" value={draft.baseUrl} onChange={(e) => onChange({ ...draft, baseUrl: e.target.value })} /></label>
				<label className="block space-y-1 text-xs text-mut"><span>渠道文档来源</span><Input placeholder="渠道文档链接或说明" value={draft.source} onChange={(e) => onChange({ ...draft, source: e.target.value })} /></label>
				<Select value={draft.allChat ? "all" : "ids"} ariaLabel="适用模型" options={[{ value: "ids", label: "仅指定模型 ID" }, { value: "all", label: "全部对话模型（渠道文档保证）" }]} onChange={(v) => onChange({ ...draft, allChat: v === "all" })} />
				{!draft.allChat && <textarea className="pa-input !h-16 w-full" aria-label="适用模型 ID" placeholder="填写完整模型 ID，每行一个" value={draft.ids} onChange={(e) => onChange({ ...draft, ids: e.target.value })} />}
			</div>
			<div className="space-y-2" data-testid="relay-scope-defaults"><p className="text-xs font-medium">默认能力</p><Facts facts={draft.defaults} onChange={(defaults) => onChange({ ...draft, defaults })} /></div>
			<details className="space-y-2">
				<summary className="cursor-pointer text-xs">模型例外（{draft.exceptions.length}）</summary>
				<div className="max-h-80 space-y-2 overflow-y-auto">
					{draft.exceptions.map(([id, facts], i) => {
						const update = (next: [string, RelayCapabilityFacts]) => onChange({ ...draft, exceptions: draft.exceptions.map((item, j) => j === i ? next : item) });
						return <div key={i} className="space-y-2 rounded-lg border border-line p-2" data-testid="relay-scope-exception">
							<div className="flex gap-2"><Input aria-label="例外模型 ID" placeholder="完整模型 ID" value={id} onChange={(e) => update([e.target.value, facts])} /><Button size="sm" variant="ghost" onClick={() => onChange({ ...draft, exceptions: draft.exceptions.filter((_, j) => j !== i) })}>移除</Button></div>
							<Facts facts={facts} onChange={(next) => update([id, next])} />
						</div>;
					})}
				</div>
				<Button size="sm" variant="ghost" onClick={() => onChange({ ...draft, exceptions: [...draft.exceptions, ["", {}]] })}>添加例外</Button>
			</details>
		</>}
		{error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
	</div>;
}
