/**
 * `agy models` 的输出 → 模型家族（纯函数）。方案：docs/design/cli-models.md §5b.1 第 10 条、§5b.2 审查定稿。
 *
 * 输出每行 `<id>\t<显示名>`，id 末段 `low / medium / high` 就是思考强度（如 `claude-sonnet-5-5-high`）。
 * Pi 里每个「家族」（去掉末段）一项，思考强度映射回 id 后缀；只有一个档位的家族不给思考强度选项。
 */

export const AGY_EFFORTS = ["low", "medium", "high"] as const;
export type AgyEffort = (typeof AGY_EFFORTS)[number];

export interface AgyFamily {
	/** 家族 id（去掉档位后缀），如 `claude-sonnet-5-5`；没有档位后缀的模型就是它自己的 id */
	id: string;
	/** 显示名（去掉括号里的档位），如 `Claude Sonnet 5.5` */
	name: string;
	/** 档位 → agy 里的完整 id；没有档位后缀的家族为空 */
	variants: Partial<Record<AgyEffort, string>>;
}

const SUFFIX = /^(.+)-(low|medium|high)$/;
const NAME_SUFFIX = /\s*\((?:low|medium|high)\)\s*$/i;

/** 解析 `agy models` 的 stdout；没有制表符的行（如 `Fetching available models...`）忽略。 */
export function parseAgyModels(stdout: string): AgyFamily[] {
	const families = new Map<string, AgyFamily>();
	for (const line of stdout.split(/\r?\n/)) {
		const [rawId, rawName] = line.split("\t");
		const id = rawId?.trim();
		if (!id || rawName === undefined || /\s/.test(id)) continue;
		const m = SUFFIX.exec(id);
		const familyId = m ? m[1] : id;
		const name = rawName.trim().replace(NAME_SUFFIX, "") || familyId;
		const fam = families.get(familyId) ?? { id: familyId, name, variants: {} };
		if (m) fam.variants[m[2] as AgyEffort] = id;
		families.set(familyId, fam);
	}
	return [...families.values()];
}

/** 家族能选的档位（按低到高）；少于两档就没有选择 */
export const effortsOf = (f: AgyFamily): AgyEffort[] => AGY_EFFORTS.filter((e) => f.variants[e]);

/**
 * Pi 的思考强度 → agy 完整模型 id。Pi 比 high 更高的档位（xhigh / max）取 high；没指定取 medium；
 * 想要的档位这个家族没有就取最近的。不认识的家族原样返回（当作已经是完整 id）。
 */
export function resolveAgyModel(families: readonly AgyFamily[], familyId: string, effort: string | undefined): string {
	const fam = families.find((f) => f.id === familyId);
	if (!fam) return familyId;
	if (!effortsOf(fam).length) return fam.id;
	const want: AgyEffort = effort === "low" || effort === "medium" || effort === "high" ? effort : effort === "xhigh" || effort === "max" ? "high" : "medium";
	const order: AgyEffort[] = want === "low" ? ["low", "medium", "high"] : want === "high" ? ["high", "medium", "low"] : ["medium", "high", "low"];
	return fam.variants[order.find((e) => fam.variants[e]) as AgyEffort]!;
}

/** Pi 的 `thinkingLevelMap`：minimal 没有对应档位；xhigh / max 取 high。家族不足两档（没得选）返回 undefined。 */
export function agyThinkingMap(f: AgyFamily): Record<string, string | null> | undefined {
	const efforts = effortsOf(f);
	if (efforts.length < 2) return undefined;
	const pick = (e: AgyEffort) => (efforts.includes(e) ? e : null);
	return { minimal: null, low: pick("low"), medium: pick("medium"), high: pick("high"), xhigh: pick("high"), max: pick("high") };
}
