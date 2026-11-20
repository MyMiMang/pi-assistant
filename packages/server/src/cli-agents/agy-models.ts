/** `agy models` 的 TSV 目录 → 模型家族和实际发送给 agy 的完整 ID（纯函数）。 */
export const AGY_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgyEffort = (typeof AGY_EFFORTS)[number];

export interface AgyFamily {
	/** 家族 ID；对固定模型即目录中的完整 ID。 */
	id: string;
	name: string;
	/** 目录确实列出了不带本家族档位的行时，才有基础 ID。 */
	baseId?: string;
	/** 仅收录有目录证据的档位 → agy 完整 ID。 */
	variants: Partial<Record<AgyEffort, string>>;
}

const SUFFIX = new RegExp(`^(.+)-(${AGY_EFFORTS.join("|")})$`);
const NAME_SUFFIX = new RegExp(`\\s*\\((${AGY_EFFORTS.join("|")})\\)$`, "i");
const DEFAULT_ORDER: readonly AgyEffort[] = ["medium", "high", "low", "xhigh", "max"];

/** 先读取完整目录，避免把固定模型名末尾的 low / high / max 等误当成档位。 */
export function parseAgyModels(stdout: string): AgyFamily[] {
	const rows = new Map<string, string>();
	for (const line of stdout.split(/\r?\n/)) {
		const [rawId, rawName] = line.split("\t");
		const id = rawId?.trim();
		if (!id || rawName === undefined || /\s/.test(id) || rows.has(id)) continue;
		rows.set(id, rawName.trim());
	}

	const variants = new Map<string, { familyId: string; name: string; effort: AgyEffort }>();
	const names = new Map<string, string>();
	const ambiguous = new Set<string>();
	// 短 ID 先判定，已经被确认为档位的行不能再当另一个家族的基础行。
	for (const [id, name] of [...rows].sort(([a], [b]) => a.length - b.length)) {
		const suffix = SUFFIX.exec(id);
		if (!suffix || !name) continue;
		const [, familyId, rawEffort] = suffix;
		const effort = rawEffort as AgyEffort;
		const label = NAME_SUFFIX.exec(name);
		if (label && label[1].toLowerCase() !== effort) continue;
		const familyName = label ? name.slice(0, label.index) : name;
		const baseName = rows.get(familyId);
		if (!familyName || (!label && baseName !== familyName)) continue;
		// 同 ID 的基础行若另有其名（或已经是档位），不要覆盖或混入它。
		if (baseName !== undefined && (baseName !== familyName || variants.has(familyId))) continue;
		if (names.has(familyId) && names.get(familyId) !== familyName) ambiguous.add(familyId);
		names.set(familyId, familyName);
		variants.set(id, { familyId, name: familyName, effort });
	}

	const families = new Map<string, AgyFamily>();
	for (const [id, name] of rows) {
		const candidate = variants.get(id);
		const variant = candidate && !ambiguous.has(candidate.familyId) ? candidate : undefined;
		const familyId = variant?.familyId ?? id;
		const family = families.get(familyId) ?? { id: familyId, name: (variant?.name ?? name) || id, variants: {} };
		if (variant) family.variants[variant.effort] = id;
		else family.baseId = id;
		families.set(familyId, family);
	}
	return [...families.values()];
}

/** 目录确实有的档位（按低到高），包括只有一档的家族。 */
export const effortsOf = (f: AgyFamily): AgyEffort[] => AGY_EFFORTS.filter((e) => f.variants[e]);

export type AgySelection = { modelId: string; familyId: string } & (
	| { source: "default-base"; effort?: never }
	| { source: "explicit" | "legacy-id" | "default-variant"; effort: AgyEffort }
);

/** 只有未指定档位才允许取目录默认；完整旧 ID 已锁定档位，不换成兄弟档。 */
export function resolveAgySelection(families: readonly AgyFamily[], modelId: string, effort?: string): AgySelection {
	const family = families.find((f) => f.id === modelId);
	if (!family) {
		for (const f of families) {
			const exact = AGY_EFFORTS.find((e) => f.variants[e] === modelId);
			if (exact === undefined) continue;
			if (effort === undefined || effort === exact) {
				return { modelId, familyId: f.id, effort: exact, source: effort === undefined ? "legacy-id" : "explicit" };
			}
			throw new Error(`Antigravity 模型「${modelId}」固定为 ${exact}，不支持思考档位「${effort}」。请重新选择模型或档位。`);
		}
		throw new Error(`Antigravity 目录找不到模型「${modelId}」。请重新检测并选择模型。`);
	}

	const familyId = family.id;
	if (effort !== undefined) {
		const exact = AGY_EFFORTS.find((e) => e === effort);
		if (exact !== undefined) {
			const id = family.variants[exact];
			if (id) return { modelId: id, familyId, effort: exact, source: "explicit" };
		}
		throw new Error(`Antigravity 模型「${modelId}」不支持思考档位「${effort}」。请重新选择档位。`);
	}
	if (family.baseId) return { modelId: family.baseId, familyId, source: "default-base" };
	for (const fallback of DEFAULT_ORDER) {
		const id = family.variants[fallback];
		if (id) return { modelId: id, familyId, effort: fallback, source: "default-variant" };
	}
	throw new Error(`Antigravity 目录没有模型「${modelId}」可发送的完整 ID。请重新检测并选择模型。`);
}

export function resolveAgyModel(families: readonly AgyFamily[], familyId: string, effort: string | undefined): string {
	return resolveAgySelection(families, familyId, effort).modelId;
}

/** Pi 的 `thinkingLevelMap`：只映射目录证实的同名档位；固定模型不提供映射。 */
export function agyThinkingMap(f: AgyFamily): Record<string, string | null> | undefined {
	const efforts = effortsOf(f);
	if (!efforts.length) return undefined;
	return { off: null, minimal: null, ...Object.fromEntries(AGY_EFFORTS.map((e) => [e, efforts.includes(e) ? e : null])) };
}
