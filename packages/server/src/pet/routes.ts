/** 桌宠的 HTTP 接口（在 http.ts 里挂载）。桌宠窗口只在本机打开，所以都是 localOnly */
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import type { Hono, MiddlewareHandler } from "hono";
import { getAgent } from "../runtime.ts";
import { defaultImageModel, getProvider, labelOf, runGeneration } from "../image-gen/index.ts";
import { ImageGenError, supportsEdit } from "../image-gen/providers.ts";
import { deletePet, listPets, parseManifest, petOf, petSettings, petSheetPath, petStatus, savePet, savePetSettings, setPetOf, type PetSettings } from "./index.ts";

const dataUrl = (s: unknown): Buffer | null => {
	if (typeof s !== "string") return null;
	const m = /^data:[\w/+.-]+;base64,(.+)$/s.exec(s);
	return m ? Buffer.from(m[1], "base64") : null;
};
/** 孵化用的五个基础姿势（每个姿势一张图，前端再做成各行动画） */
export const HATCH_POSES = ["base", "happy", "sad", "working", "thinking", "asking"] as const;
const POSE_PROMPT: Record<(typeof HATCH_POSES)[number], string> = {
	base: "standing front-facing, calm, gentle smile, arms down",
	happy: "jumping with joy, both arms raised, eyes closed in a big happy smile",
	sad: "sad and deflated, drooping posture, teary eyes, frown",
	working: "focused and determined, typing busily on an invisible keyboard, slight frown of concentration",
	thinking: "thinking, head tilted, one paw on chin, looking up",
	asking: "raising one paw high like asking a question, curious hopeful face",
};
/** 参考 openai/skills hatch-pet（Apache-2.0）的风格要求：Q 版、粗描边、平涂、没有脱离身体的特效；纯色背景方便去底 */
export function hatchPrompt(desc: string, pose: (typeof HATCH_POSES)[number]) {
	return [
		`A cute chibi desktop-pet mascot: ${desc.trim().slice(0, 300)}.`,
		`Pose: ${POSE_PROMPT[pose]}.`,
		"Full body, single character, centered, small compact proportions with a big head, chunky readable silhouette, thick dark outline, flat cel shading, limited palette, simple expressive face, tiny limbs.",
		"Plain solid pure white background (#FFFFFF), nothing else in the image: no shadow, no floor, no text, no frame, no speed lines, no sparkles, no detached effects.",
		pose === "base" ? "" : "Keep exactly the same character design, colors and proportions as the reference image.",
	]
		.filter(Boolean)
		.join(" ");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mountPetRoutes(app: Hono<any>, admin: MiddlewareHandler<any>) {
	app.get("/api/pet/state", admin, (c) => c.json(petStatus()));
	app.get("/api/pet/settings", admin, (c) => c.json(petSettings()));
	app.put("/api/pet/settings", admin, async (c) => c.json(savePetSettings(await c.req.json<Partial<PetSettings>>())));
	app.get("/api/pets", admin, (c) => c.json({ items: listPets(), settings: petSettings() }));
	app.get("/api/pets/:id/sheet", (c) => {
		const f = petSheetPath(c.req.param("id"));
		if (!f) return c.json({ error: "not_found" }, 404);
		c.header("Content-Type", f.mime);
		c.header("Content-Length", String(statSync(f.path).size));
		c.header("Cache-Control", "private, max-age=86400");
		return c.body(Readable.toWeb(createReadStream(f.path)) as ReadableStream);
	});
	/** 导入 / 保存孵化结果：{ sheet: dataURL, manifest?: pet.json 文本, name?, description?, prompt? } */
	app.post("/api/pets", admin, async (c) => {
		try {
			const b = await c.req.json<{ sheet?: string; manifest?: string; name?: string; description?: string; prompt?: string }>();
			const sheet = dataUrl(b.sheet);
			if (!sheet) return c.json({ ok: false, error: "缺少精灵图" }, 400);
			const m = parseManifest(b.manifest);
			const pet = savePet({ name: b.name || m.name || "我的宠物", description: b.description ?? m.description, sheet, idHint: m.id, prompt: b.prompt });
			return c.json({ ok: true, pet });
		} catch (e) {
			return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	app.delete("/api/pets/:id", admin, (c) => {
		try {
			return c.json({ ok: deletePet(c.req.param("id")) });
		} catch (e) {
			return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	app.get("/api/agents/:id/pet", admin, (c) => c.json({ pet: petOf(c.req.param("id")) }));
	app.put("/api/agents/:id/pet", admin, async (c) => {
		if (!getAgent(c.req.param("id"))) return c.json({ error: "not_found" }, 404);
		try {
			const b = await c.req.json<{ pet: string | null }>();
			setPetOf(c.req.param("id"), b.pet || null);
			return c.json({ ok: true, pet: petOf(c.req.param("id")) });
		} catch (e) {
			return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	/** 孵化：现在用哪个图片模型（没配置就是 null） */
	app.get("/api/pets/hatch", admin, (c) => {
		const d = defaultImageModel();
		const p = d ? getProvider(d.provider) : undefined;
		return c.json({ model: d && p ? { ...d, label: labelOf(d), edit: supportsEdit(p.kind, d.model) } : null, poses: HATCH_POSES });
	});
	/** 孵化：画一个姿势。{ description, pose, reference?: dataURL（第一张定妆图，用来保持同一个角色） } */
	app.post("/api/pets/hatch/pose", admin, async (c) => {
		const b = await c.req.json<{ description?: string; pose?: string; reference?: string }>();
		const d = defaultImageModel();
		if (!d) return c.json({ ok: false, code: "no_model", error: "还没有配置图片生成模型" }, 400);
		const desc = (b.description ?? "").trim();
		if (!desc) return c.json({ ok: false, error: "先用一句话描述你的宠物" }, 400);
		const pose = HATCH_POSES.includes(b.pose as never) ? (b.pose as (typeof HATCH_POSES)[number]) : "base";
		const ref = dataUrl(b.reference);
		const p = getProvider(d.provider)!;
		const useRef = !!ref && supportsEdit(p.kind, d.model);
		try {
			const r = await runGeneration(d, { prompt: hatchPrompt(desc, pose), n: 1, aspect: "1:1", quality: "medium", images: useRef ? [{ name: "reference.png", mime: "image/png", data: ref! }] : undefined, signal: c.req.raw.signal });
			const img = r.images[0];
			if (!img) throw new ImageGenError("empty", "没有图片");
			return c.json({ ok: true, pose, image: `data:${img.mime};base64,${img.data.toString("base64")}`, usedReference: useRef });
		} catch (e) {
			const err = e instanceof ImageGenError ? e : null;
			// 200 + ok:false：前端要按 code 决定重试还是放弃
			return c.json({ ok: false, code: err?.code, error: err ? err.message : e instanceof Error ? e.message : String(e) });
		}
	});
}
