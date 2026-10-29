/**
 * `opencode models --verbose` 的输出 → 模型列表（纯函数）。方案：docs/design/acp-cli-models.md。
 *
 * 输出是若干段：一行 `<provider>/<model>`，后面跟一段缩进的 JSON（顶格 `{` 开头、顶格 `}` 结尾）。字段（实测 1.18.35）：
 * `name`、`providerID`、`status`、`cost`（每百万 token 的价，0 = 免费）、`limit.context` / `limit.output`、
 * `capabilities.toolcall` / `capabilities.input.image`、`variants`（键 = 思考强度，如 `low` / `high` / `max`；没有 = 不能选）。
 * Pi 里的模型 id 用 OpenCode 的 `<provider>/<model>`（ACP `session/set_config_option` 的值也是它）。
 * 只留支持工具调用的（我们靠工具桥干活）；名字要能分清 Zen 按量（`opencode/`）、Go 套餐（`opencode-go/`）和用户自己登录的其他 provider。
 */

export interface OpencodeModel {
	/** `<provider>/<model>` */
	id: string;
	/** 显示名，已带上来源，如 `DeepSeek V4.1 Flash（OpenCode Go）` */
	name: string;
	providerID: string;
	/** 思考强度的值（`variants` 的键）；空 = 不能选 */
	efforts: string[];
	image: boolean;
	contextWindow: number;
	maxTokens: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const posNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

/** 保守默认：取不到上下文长度 / 最大输出时用 */
const DEFAULT_CONTEXT = 128_000;
const DEFAULT_MAX_OUTPUT = 16_000;

/** 来源说明：Zen 免费 / 按量、Go 套餐、其他 provider 用它自己的 id */
export function opencodeSourceLabel(providerID: string, free: boolean): string {
	if (providerID === "opencode") return free ? "OpenCode Zen 免费" : "OpenCode Zen 按量";
	if (providerID === "opencode-go") return "OpenCode Go";
	return providerID;
}

/** 切出 `<ref>` + JSON 段 */
function sections(stdout: string): Array<{ ref: string; json: unknown }> {
	const lines = stdout.split(/\r?\n/);
	const out: Array<{ ref: string; json: unknown }> = [];
	for (let i = 0; i < lines.length; i++) {
		const ref = lines[i].trim();
		if (!/^[^\s{}"]+\/\S+$/.test(ref) || lines[i + 1]?.trim() !== "{") continue;
		let end = i + 1;
		while (end < lines.length && lines[end] !== "}") end++;
		if (end >= lines.length) break;
		try {
			out.push({ ref, json: JSON.parse(lines.slice(i + 1, end + 1).join("\n")) });
		} catch {
			// 这一段看不懂：跳过
		}
		i = end;
	}
	return out;
}

/** 解析 `opencode models --verbose` 的 stdout；去掉不支持工具调用的和已弃用的。 */
export function parseOpencodeModels(stdout: string): OpencodeModel[] {
	const out: OpencodeModel[] = [];
	for (const { ref, json } of sections(stdout)) {
		if (!isObj(json)) continue;
		const caps = isObj(json.capabilities) ? json.capabilities : {};
		if (caps.toolcall !== true || json.status === "deprecated") continue;
		const providerID = typeof json.providerID === "string" ? json.providerID : ref.split("/")[0];
		const cost = isObj(json.cost) ? json.cost : {};
		const free = cost.input === 0 && cost.output === 0;
		const limit = isObj(json.limit) ? json.limit : {};
		const input = isObj(caps.input) ? caps.input : {};
		const base = typeof json.name === "string" && json.name.trim() ? json.name.trim() : ref.slice(ref.indexOf("/") + 1);
		out.push({
			id: ref,
			name: `${base}（${opencodeSourceLabel(providerID, free)}）`,
			providerID,
			efforts: isObj(json.variants) ? Object.keys(json.variants) : [],
			image: input.image === true,
			contextWindow: posNum(limit.context) ?? DEFAULT_CONTEXT,
			maxTokens: Math.min(posNum(limit.output) ?? DEFAULT_MAX_OUTPUT, posNum(limit.context) ?? DEFAULT_CONTEXT),
		});
	}
	return out;
}

/** Pi 的 `thinkingLevelMap`：每个档位对应 `variants` 里的同名键，没有就不支持。没有可选的思考强度返回 undefined。 */
export function opencodeThinkingMap(efforts: readonly string[]): Record<string, string | null> | undefined {
	if (!efforts.length) return undefined;
	const pick = (e: string) => (efforts.includes(e) ? e : null);
	return { minimal: pick("minimal"), low: pick("low"), medium: pick("medium"), high: pick("high"), xhigh: pick("xhigh"), max: pick("max") };
}
