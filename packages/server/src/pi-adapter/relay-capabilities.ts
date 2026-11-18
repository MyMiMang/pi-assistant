import { isThinkingLevel, THINKING_LEVEL_ORDER } from "@pi-assistant/shared";
import type { CustomModel, CustomProviderMeta } from "./custom-providers.ts";
import { effectiveApi, effectiveBaseUrl } from "./relay-protocols.ts";

export interface CapabilityFacts {
 vision?: boolean;
 reasoning?: boolean;
 /** A string is a documented protocol value. For off, null means omit; absent means unknown. */
 levels?: Record<string, string | null>;
}
export interface CapabilityScope {
 api: string;
 baseUrl: string;
 source: string;
 appliesTo: "all-chat" | string[];
 defaults: CapabilityFacts;
 exceptions?: Record<string, CapabilityFacts>;
}
export interface ModelListEvidence extends CapabilityFacts {
 provider?: string;
 model: string;
 api: string;
 baseUrl: string;
}

export const scopedProtocol = (api: string) => api === "openai-completions" || api === "openai-responses";
export const cleanEndpoint = (url: string) => url.trim().replace(/\/+$/, "");
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const validFacts = (v: unknown, allowLevels = true): v is CapabilityFacts => record(v) && Object.entries(v).every(([k, x]) => {
 if (k === "vision" || k === "reasoning") return typeof x === "boolean";
 return allowLevels && k === "levels" && record(x) && Object.entries(x).every(([level, value]) => isThinkingLevel(level) && (value === null || (typeof value === "string" && !!value.trim())));
});

export function validScope(v: unknown): v is CapabilityScope {
 if (!record(v) || typeof v.api !== "string" || !scopedProtocol(v.api) || typeof v.baseUrl !== "string" || !/^https?:\/\//.test(v.baseUrl) || typeof v.source !== "string" || !v.source.trim()) return false;
 if (v.appliesTo !== "all-chat" && (!Array.isArray(v.appliesTo) || !v.appliesTo.length || !v.appliesTo.every((id) => typeof id === "string" && id.trim() && id === id.trim()))) return false;
 return validFacts(v.defaults) && (v.exceptions === undefined || (record(v.exceptions) && Object.entries(v.exceptions).every(([id, facts]) => !!id.trim() && validFacts(facts))));
}

export function matchingEvidence(meta: Pick<CustomProviderMeta, "id" | "api" | "baseUrl" | "protocolUrls">, m: CustomModel, allowUnbound = false) {
 const e = m.listEvidence;
 if (!e || (e.provider !== meta.id && !(allowUnbound && e.provider === undefined)) || e.model !== m.id || !scopedProtocol(e.api) || e.api !== effectiveApi(meta, m) || e.baseUrl !== cleanEndpoint(effectiveBaseUrl(meta, m))) return undefined;
 return validFacts({ ...(e.vision !== undefined ? { vision: e.vision } : {}), ...(e.reasoning !== undefined ? { reasoning: e.reasoning } : {}) }, false) ? e : undefined;
}

/** Single effective projection for UI, metadata registry and Pi registration; never written back as manual settings. */
export function effectiveRelayModel(meta: CustomProviderMeta, m: CustomModel) {
 const api = effectiveApi(meta, m);
 if (!scopedProtocol(api)) return { ...m, effectiveCapability: undefined };
 const scope = meta.capabilityScope;
 const covered = scope && scope.api === api && cleanEndpoint(scope.baseUrl) === cleanEndpoint(effectiveBaseUrl(meta, m)) && m.detectedType !== "classifier" && !meta.classifiers?.some((c) => c.modelId === m.id) && !meta.discoveredClassifiers?.some((c) => c.modelId === m.id)
  && (scope.appliesTo === "all-chat" ? !m.capabilities || m.capabilities.includes("chat") : scope.appliesTo.includes(m.id)) ? scope : undefined;
 const exact = covered && Object.hasOwn(covered.exceptions ?? {}, m.id) ? covered.exceptions?.[m.id] : undefined;
 const remote = matchingEvidence(meta, m);
 const candidates = [[exact, "渠道例外"], [remote, "/models"], [covered?.defaults, "渠道范围"]] as const;
 const vision = m.visionOverride !== undefined ? m.visionOverride ?? undefined : m.input && !m.inputAuto ? m.input.includes("image") : m.capabilities?.includes("vision") ? true : undefined;
 const manual: CapabilityFacts = { vision, reasoning: m.reasoningAuto ? undefined : m.reasoning, levels: m.thinkingLevelSource === "user" ? m.thinkingLevelMap : undefined };
 const evidence = <K extends keyof CapabilityFacts>(key: K) => ([[manual, "手动"], ...candidates] as const).find(([facts]) => facts?.[key] !== undefined);
 const v = evidence("vision");
 const r = evidence("reasoning");
 const l = evidence("levels");
 const image = v?.[0]?.vision;
 const reasoning = r?.[0]?.reasoning;
 const levels = reasoning === false ? undefined : l?.[0]?.levels;
 const off = levels?.off;
 return {
  ...m,
  input: image === undefined ? undefined : image ? ["text", "image"] as ("text" | "image")[] : ["text"] as ("text" | "image")[],
  reasoning,
  thinkingLevelMap: reasoning === true && levels ? Object.fromEntries(THINKING_LEVEL_ORDER.map((level) => [level, levels[level]?.trim() || null])) : undefined,
  effectiveCapability: { vision: image, visionSource: v?.[1], reasoning, reasoningSource: r?.[1], levels, levelsSource: levels ? l?.[1] : undefined, off: off === undefined ? "unknown" : off === null ? "omit" : "value", source: covered?.source },
 };
}
