/**
 * Claude Code 的「自定义模型 ID」：用户在设置卡里加的、`claude --model` 能接受的完整模型 ID（方案 docs/design/cli-models.md §4.2）。
 * 存储：settings["claudeCustomModels"] = string[]；校验用 claude-models-parse 的 `validateClaudeModelId`。
 */
import { validateClaudeModelId } from "./cli-agents/claude-models-parse.ts";
import { getSetting, setSetting } from "./db.ts";

const KEY = "claudeCustomModels";

/** 已加的自定义模型 ID（结构损坏 / 非法项按没有处理） */
export function claudeCustomModels(): string[] {
	const raw = getSetting<unknown>(KEY, []);
	return Array.isArray(raw) ? [...new Set(raw.filter((x): x is string => typeof x === "string" && !validateClaudeModelId(x)))] : [];
}

/** 加一个；ID 不合法抛中文错误，已存在则原样返回 */
export function addClaudeCustomModel(raw: unknown): string[] {
	const err = validateClaudeModelId(typeof raw === "string" ? raw.trim() : raw);
	if (err) throw new Error(err);
	const id = (raw as string).trim();
	const list = claudeCustomModels();
	if (list.includes(id)) return list;
	const next = [...list, id];
	setSetting(KEY, next);
	return next;
}

export function removeClaudeCustomModel(id: string): string[] {
	const next = claudeCustomModels().filter((x) => x !== id);
	setSetting(KEY, next);
	return next;
}
