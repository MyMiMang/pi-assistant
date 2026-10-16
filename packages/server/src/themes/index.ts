/**
 * 外观主题 AI 创作（后端）：把「设置 → 外观 → 用 AI 设计主题」接到**真实的 Pi 会话**上。
 *
 * 设计要点（与 docs/design/appearance-themes.md §5 一致）：
 *  - 复用当前助理已选的模型（`runtime(agentId).modelFor(agent)`；没有就明确报错，**不猜、不取第一个模型**）。
 *  - 开一个**临时专用会话**：内存会话（不落盘）、只加载 `theme_draft` 一个工具、
 *    不加载 MCP / codemode / tool-search / 任何 ext-*（所以没有 bash / 主机 / 桌面 / 邮箱 / 审批 / 交付）。
 *    不动主聊天会话、不动当前对话选择、不写用户会话历史；`minimalExtensions` 保证这些**不能靠 prompt 解除**。
 *  - 结构化产出：模型只能经 `theme_draft` 工具提交，服务端用 shared 校验器 fail-closed 校验；
 *    校验不过就保留上一版（不 apply），最多允许一次格式修复。
 *  - 图片只走附件 opaque id：服务端按 canonical owner + magic bytes 解析，模型不能塞图片、不能读别的文件。
 *  - 预算：用用户已选的服务正常调用，用量沿用既有 `recordUsage`；取消 / 超时会真的 abort 模型请求。
 *  - 同一 (agentId, turnId) 并发去重，避免界面重发造成重复付费。
 */
import { defaultThinking, models, customProviders, providerNames } from "../models.ts";
import { getAgent, runtime } from "../runtime.ts";
import { supportsVision } from "../vision.ts";
import { workspaceOf } from "../files.ts";
import { config } from "../config.ts";
import { join } from "node:path";
import { recordUsage } from "../usage/index.ts";
import { abortSession, createPiSession, disposeSession, lastAssistantText, promptSession, subscribeSession, type AgentSession } from "../pi-adapter/index.ts";
import { validateThemeManifest, type ThemeDraftRequest, type ThemeDraftResult, type ThemeError, type ThemeManifestV1, type ThemeModelRef } from "@pi-assistant/shared";
import { resolveThemeImages } from "./images.ts";
import { themeDesignSystemPrompt, themeDraftTool } from "./tool.ts";

/** 一次设计请求的最长等待（到点 abort，避免界面一直转圈 / 无限计费）。 */
export const THEME_DRAFT_TIMEOUT_MS = 180_000;

/** 测试可缩短超时；生产保持 THEME_DRAFT_TIMEOUT_MS。 */
let timeoutMs = THEME_DRAFT_TIMEOUT_MS;
export function setThemeDraftTimeoutForTest(ms: number) {
	timeoutMs = ms;
}

/** 正在处理中的 (agentId:turnId)：防止界面重发同一轮造成重复付费。 */
const inFlight = new Set<string>();

const err = (path: string, code: ThemeError["code"], message: string, actual?: string): ThemeError => ({ path, code, message, actual });

/** 服务 id → 展示短名（用户给自定义服务起的名字也算）。 */
function modelInfo(ref: { provider: string; id: string }): ThemeModelRef {
	return { provider: ref.provider, id: ref.id, providerName: providerNames().get(ref.provider) ?? ref.provider, name: models.getModel(ref.provider, ref.id)?.name ?? ref.id };
}

/** 这个模型服务是否已配置（内置看 configured，自定义看它自己的 configured）。 */
function providerConfigured(id: string): boolean {
	const p = models.listProviders().find((x) => x.id === id);
	const c = customProviders.list().find((x) => x.id === id);
	return !!(p?.configured || c?.configured);
}

/**
 * 解析这一轮要用的模型：
 *  - 面板显式传了 `model`：必须是**真实存在**的聊天模型，且服务已配置；否则明确报错，
 *    **不 fallback 到另一个收费模型**（同 id 不同 provider 也按 canonical provider 区分）。
 *  - 不传（旧客户端语义）：按 `runtime(agentId).modelFor(agent)`（当前助理模型，未设则默认模型）。
 */
function resolveThemeModel(agentId: string, agent: NonNullable<ReturnType<typeof getAgent>>, requested?: ThemeModelRef): { ref: { provider: string; id: string } | null; error?: ThemeError; info?: ThemeModelRef } {
	if (requested && (requested.provider != null || requested.id != null)) {
		const provider = typeof requested.provider === "string" ? requested.provider.trim() : "";
		const id = typeof requested.id === "string" ? requested.id.trim() : "";
		if (!provider || !id) return { ref: null, error: err("model", "required", "模型引用不完整（需要 provider + id）") };
		if (!models.getModel(provider, id)) return { ref: null, error: err("model", "value", `选的模型（${provider}/${id}）已不存在或不可用，请重新选择；不会自动改用别的模型`, `${provider}/${id}`) };
		if (!providerConfigured(provider)) return { ref: null, error: err("model", "required", `模型服务「${providerNames().get(provider) ?? provider}」还没登录或缺少凭据，请先在设置 › 模型里配置；不会自动改用别的模型`, provider), info: modelInfo({ provider, id }) };
		return { ref: { provider, id }, info: modelInfo({ provider, id }) };
	}
	const m = runtime(agentId).modelFor(agent);
	if (!m) return { ref: null };
	return { ref: m, info: modelInfo(m) };
}

/** 测试用：清掉并发去重表（单测之间不互相影响）。 */
export function resetThemeDraftInFlight() {
	inFlight.clear();
}

export async function draftTheme(req: ThemeDraftRequest, opts: { signal?: AbortSignal } = {}): Promise<ThemeDraftResult> {
	const turnId = typeof req?.turnId === "string" && req.turnId.trim() ? req.turnId.trim() : "t?";
	const fail = (errors: ThemeError[], extra: Partial<{ visionUnsupported: boolean; text: string; model: ThemeModelRef }> = {}): ThemeDraftResult => ({ ok: false, turnId, errors, warnings: [], ...extra });

	const prompt = typeof req?.prompt === "string" ? req.prompt.trim() : "";
	if (!prompt) return fail([err("prompt", "required", "请先说一句想要的主题")]);

	const agentId = typeof req?.agentId === "string" ? req.agentId.trim() : "";
	if (!agentId) return fail([err("agentId", "required", "缺少 agentId：主题设计按当前助理的模型走，不猜模型、不取第一个模型")]);
	const agent = getAgent(agentId);
	if (!agent) return fail([err("agentId", "value", "这个助理不存在，已拒绝", agentId)]);

	// 模型在这一轮开始时解析（面板已把选定模型快照进请求，运行中换模型不会混进本轮）。
	const resolved = resolveThemeModel(agentId, agent, req.model);
	if (resolved.error) return fail([resolved.error], resolved.info ? { model: resolved.info } : {});
	if (!resolved.ref) return fail([err("model", "required", "还没有可用的模型：请先在「设置 → 模型」里登录并选一个默认模型")], resolved.info ? { model: resolved.info } : {});

	const key = `${agentId}:${turnId}`;
	if (inFlight.has(key)) return fail([err("turnId", "value", "这一轮请求正在处理中（已拦下重复请求，避免重复计费）", turnId)], resolved.info ? { model: resolved.info } : {});
	inFlight.add(key);
	try {
		return await runDraft({ agentId, agent, turnId, prompt, req, model: resolved.ref, modelRef: resolved.info, signal: opts.signal });
	} finally {
		inFlight.delete(key);
	}
}

async function runDraft(o: {
	agentId: string;
	agent: NonNullable<ReturnType<typeof getAgent>>;
	turnId: string;
	prompt: string;
	req: ThemeDraftRequest;
	model: { provider: string; id: string };
	modelRef?: ThemeModelRef;
	signal?: AbortSignal;
}): Promise<ThemeDraftResult> {
	const { agentId, agent, turnId } = o;
	const model = o.model;
	const modelRef = o.modelRef;
	const fail = (errors: ThemeError[], extra: Partial<{ visionUnsupported: boolean; text: string; model: ThemeModelRef }> = {}): ThemeDraftResult => ({ ok: false, turnId, errors, warnings: [], model: modelRef, ...extra });

	// 参考图：按附件 opaque id 解析（canonical owner + magic bytes + 上限），任何一张不合格整批拒绝。
	const imgs = await resolveThemeImages(agentId, o.req.images);
	if (imgs.errors.length) return fail(imgs.errors, { text: "参考图没通过校验，先不改主题。" });

	// 3) 带图但当前模型不支持看图：如实返回 visionUnsupported，**不发请求**（不偷偷换视觉服务 / 收费模型）。
	if (imgs.parts.length && !supportsVision(model)) {
		return fail([err("images", "unsupported", "当前助理的模型不支持看图")], {
			visionUnsupported: true,
			text: "当前助理的模型不支持图片输入，我看不到参考图。可以换一个支持看图的模型（设置 › 模型），或去掉图片只用文字描述；我不会自动改用别的模型看图。",
		});
	}

	// 4) 组装上一版上下文（继续修改时）。设计历史**有界**：只带上一版合法 manifest，不带整段对话。
	const previous = o.req.previousManifest && validateThemeManifest(o.req.previousManifest).ok ? (o.req.previousManifest as ThemeManifestV1) : undefined;
	const userText = buildUserText(o.prompt, previous);

	let accepted: ThemeManifestV1 | null = null;
	let lastRejected: ThemeError[] = [];
	const tool = themeDraftTool({
		previous,
		images: imgs.refs,
		onAccepted: (m) => {
			accepted = m;
		},
		onRejected: (errors) => {
			lastRejected = errors;
		},
	});

	let session: AgentSession | null = null;
	let unsub: (() => void) | null = null;
	let aborted = false;
	const onExternalAbort = () => {
		aborted = true;
		if (session) void abortSession(session);
	};
	const timer = setTimeout(() => {
		aborted = true;
		if (session) void abortSession(session);
	}, timeoutMs);
	o.signal?.addEventListener("abort", onExternalAbort, { once: true });

	try {
		session = await createPiSession({
			models,
			cwd: workspaceOf(agentId),
			agentDir: join(config.agentsDir, agentId),
			sessionDir: join(config.agentsDir, agentId, "sessions"),
			model,
			thinking: models.clampThinking(model.provider, model.id, agent.thinking ?? defaultThinking()),
			systemPromptAppend: [themeDesignSystemPrompt()],
			extensions: [],
			minimalExtensions: true,
			inMemorySession: true,
			tools: ["theme_draft"],
			customTools: [tool],
		});
		// 用量沿用既有记账（生产点一次就按用户已选服务正常计费）
		unsub = subscribeSession(session, (e) => {
			if (e.type === "assistant_end" && e.usage && e.provider && e.model) {
				try {
					recordUsage({ agentId, provider: e.provider, model: e.model, conversationId: null, messageId: null, ...e.usage });
				} catch {
					/* 记账失败不影响设计结果 */
				}
			}
		});
		if (aborted) {
			// 还没开始就被取消（例如面板已经关掉）
			return fail([err("turnId", "value", "请求已取消")], { text: "已取消。" });
		}
		await promptSession(session, userText, imgs.parts.length ? imgs.parts : undefined);
		const text = lastAssistantText(session).trim();
		if (aborted) return fail([err("turnId", "value", "请求已取消")], { text: "已取消。" });
		if (!accepted) {
			return fail(lastRejected.length ? lastRejected : [err("manifest", "required", "模型没有产出主题（可能没有按规范调用 theme_draft 工具）")], {
				text: text || "这次没有生成出合法主题，当前主题保持不变。",
			});
		}
		// 最终再校验一次（含服务端强制写入的图片引用），确保落地的就是合法 manifest
		const final = validateThemeManifest(accepted);
		if (!final.ok) return fail(final.errors, { text: text || "生成的 manifest 没通过校验，当前主题保持不变。" });
		return { ok: true, turnId, model: modelRef ?? modelInfo(model), manifest: final.manifest, text: text || "已生成一套主题，正在预览。", warnings: final.warnings };
	} catch (e) {
		if (aborted) return fail([err("turnId", "value", "请求已取消")], { text: "已取消。" });
		return fail([err("session", "value", `生成失败：${e instanceof Error ? e.message : String(e)}`)]);
	} finally {
		clearTimeout(timer);
		o.signal?.removeEventListener("abort", onExternalAbort);
		unsub?.();
		if (session) await disposeSession(session).catch(() => {});
	}
}

/** 用户这轮的消息：要求 + （继续修改时的）上一版 manifest（有界上下文，不带整段历史）。 */
function buildUserText(prompt: string, previous?: ThemeManifestV1): string {
	if (!previous) return `用户想要的风格：${prompt}`;
	return [`用户想在这套已有主题的基础上继续改：${prompt}`, "上一版 manifest（请在此基础上修改，不要推翻重来）：", "```json", JSON.stringify(previous), "```"].join("\n");
}
