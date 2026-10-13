/**
 * Codex 宠物精灵图（与 openai/skills hatch-pet 的 animation-rows 一致，Apache-2.0）：
 * 8 列 x 9 行（v2 是 11 行，多出的两行是“看向不同方向”，这里不用），每格 192x208。
 */
export const CELL_W = 192;
export const CELL_H = 208;
export const COLS = 8;
export type Row = "idle" | "running-right" | "running-left" | "waving" | "jumping" | "failed" | "waiting" | "running" | "review";
export const ROWS: { name: Row; frames: number; ms: number[] }[] = [
	{ name: "idle", frames: 6, ms: [280, 110, 110, 140, 140, 320] },
	{ name: "running-right", frames: 8, ms: [120, 120, 120, 120, 120, 120, 120, 220] },
	{ name: "running-left", frames: 8, ms: [120, 120, 120, 120, 120, 120, 120, 220] },
	{ name: "waving", frames: 4, ms: [140, 140, 140, 280] },
	{ name: "jumping", frames: 5, ms: [140, 140, 140, 140, 280] },
	{ name: "failed", frames: 8, ms: [140, 140, 140, 140, 140, 140, 140, 240] },
	{ name: "waiting", frames: 6, ms: [150, 150, 150, 150, 150, 260] },
	{ name: "running", frames: 6, ms: [120, 120, 120, 120, 120, 220] },
	{ name: "review", frames: 6, ms: [150, 150, 150, 150, 150, 280] },
];
export const rowIndex = (r: Row) => ROWS.findIndex((x) => x.name === r);

/** 助理状态 → 动画行 */
export type PetState = "idle" | "thinking" | "working" | "computer" | "done" | "error" | "approval" | "question";
export const STATE_ROW: Record<PetState, Row> = {
	idle: "idle",
	thinking: "review",
	working: "running",
	computer: "running",
	done: "jumping",
	error: "failed",
	approval: "waiting",
	question: "waiting",
};
export const STATE_LABEL: Record<PetState, string> = {
	idle: "空闲",
	thinking: "思考",
	working: "干活中",
	computer: "操作电脑",
	done: "完成",
	error: "出错",
	approval: "等你批准",
	question: "等你回答",
};
