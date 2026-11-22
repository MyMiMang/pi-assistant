import type { CapabilityFacts } from "./relay-capabilities.ts";

const levels = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const object = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Only the documented, exact directory/transport pairs. Never infer this from the model ID or a proxy's claim. */
function gateway(api: string, base: string) {
	if (api !== "openai-completions") return;
	if (base === "https://openrouter.ai/api/v1") return "openrouter";
	if (base === "https://ai-gateway.vercel.sh/v1") return "vercel";
}

/** https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
 * https://vercel.com/docs/ai-gateway/models-and-providers/reasoning#discover-model-reasoning-support */
export function directoryEffort(api: string, base: string, row: Record<string, unknown>): CapabilityFacts {
	const provider = gateway(api, base);
	if (!provider || row.reasoning === false || [row.type, row.model_type, row.modelType, row.kind].some(value => value === "image" || value === "classifier")) return {};
	const reasoning = object(row.reasoning);
	const options = Array.isArray(row.reasoning_options) ? row.reasoning_options.map(object).filter(x => x?.type === "effort") : [];
	const values = provider === "openrouter" ? reasoning?.supported_efforts : options.length === 1 ? options[0]?.values : undefined;
	if (!Array.isArray(values) || !values.length || values.length > 7 || new Set(values).size !== values.length || values.some(v => typeof v !== "string" || (v !== "none" && !levels.has(v)))) return {};
	const map = Object.fromEntries(values.filter(v => v !== "none" || provider !== "openrouter" || reasoning?.mandatory === false).map(v => [v === "none" ? "off" : v, v]));
	return Object.keys(map).some(k => k !== "off") ? { reasoning: true, levels: map } : {};
}

export function validDirectoryLevels(api: string, base: string, value: unknown): boolean {
	const map = object(value);
	return !!gateway(api, base) && !!map && Object.keys(map).some(k => levels.has(k)) && Object.entries(map).every(([key, val]) => key === "off" ? val === "none" : levels.has(key) && val === key);
}
