/**
 * 本地 ASR 的**运行族扩展点**（有界实现，不是巨型 plugin 架构）。
 *
 * 一个「运行族」= 一种推理引擎 + serve 脚本形态 + 权重文件角色规则。当前只有 `sensevoice`（sherpa-onnx）；
 * Paraformer / Whisper 等家族在**研究确认来源与 runner 兼容后**再注册（见 catalog.ts 的注释）。
 *
 * 有界原则：
 *  - 这里只放「生成 sidecar 脚本」与「权重清单自检」两件事，不掺生命周期 / 路由 / 许可判定；
 *  - 未注册的 family **fail closed**（抛错），绝不用一个「什么都返回同一条字幕」的假 runner 冒充；
 *  - 不同 family 的真实参数（文件角色 / 引擎构造函数）必须来自 manifest 的真实 pin，不能凭模型名猜。
 */
import type { PinnedFile } from "../managed-weights/verify.ts";
import type { AsrModelManifest } from "./manifest.ts";
import { paraformerServeScript, senseVoiceServeScript, whisperServeScript } from "./serve-script.ts";

/** sidecar 生成上下文：只传运行族需要的文件路径（相对权重目录）。 */
export interface AsrRunnerScriptContext {
	/** 权重目录内各角色文件相对路径（如 model / tokens / encoder / decoder） */
	roles: Record<string, string>;
	sampleRate: number;
	maxAudioBytes: number;
}

export interface AsrRunnerFamily {
	/** family id（manifest.runner / catalog.family 用它） */
	id: string;
	/** 界面显示用的族名 */
	label: string;
	/** 生成 sidecar Python 源码（安装时写到我们的目录，不随 App 分发权重） */
	serveScript(ctx: AsrRunnerScriptContext): string;
	/** 权重清单自检（在共享的路径安全校验之上追加族规则）；返回问题列表 */
	assertWeights(files: PinnedFile[]): string[];
	/** 该族需要的部分角色（缺一不可）；用于 precheck 给出明确错误 */
	requiredRoles: string[];
}

const families = new Map<string, AsrRunnerFamily>();

export function registerAsrRunnerFamily(family: AsrRunnerFamily): void {
	families.set(family.id, family);
}

/** 取运行族；未注册 → 抛错（fail closed，绝不假装支持）。 */
export function asrRunnerFamily(id: string): AsrRunnerFamily {
	const f = families.get(id);
	if (!f) throw new Error(`未知的本地 ASR 运行族：${id}（拒绝用未实现的 runner 冒充）`);
	return f;
}

export function hasAsrRunnerFamily(id: string): boolean {
	return families.has(id);
}

const FORBIDDEN_EXT = /\.(py|pyc|pth|pt|bin|ckpt|h5|pkl|pickle|so|dylib|dll|exe|sh|bat|ps1|safetensors)$/i;

/** 权重清单里不允许出现的可执行 / 脚本文件（不执行 repo 内任何脚本）。 */
export function assertNoExecutableWeights(files: PinnedFile[]): string[] {
	const problems: string[] = [];
	for (const f of files) {
		const rel = String(f.path).replace(/\\/g, "/");
		if (FORBIDDEN_EXT.test(rel)) problems.push(`清单含脚本 / 非预期权重格式：${rel}`);
	}
	return problems;
}

/** 校验一个 manifest 的 fileRoles 是否齐全、且都指向清单内文件。 */
export function runnerRolesOf(manifest: AsrModelManifest, family: AsrRunnerFamily): { ok: true; roles: Record<string, string> } | { ok: false; reason: string } {
	const roles = manifest.fileRoles ?? {};
	const paths = new Set(manifest.files.map((f) => String(f.path).replace(/\\/g, "/")));
	for (const role of family.requiredRoles) {
		const rel = roles[role];
		if (!rel) return { ok: false, reason: `模型清单缺少运行族 ${family.id} 需要的「${role}」文件角色` };
		if (!paths.has(rel)) return { ok: false, reason: `文件角色 ${role} 指向的文件不在清单内：${rel}` };
	}
	return { ok: true, roles };
}

// ------------------------------------------------------------ sensevoice

const SENSEVOICE_REQUIRED_ROLES = ["model", "tokens"];

registerAsrRunnerFamily({
	id: "sensevoice",
	label: "SenseVoice（sherpa-onnx）",
	requiredRoles: SENSEVOICE_REQUIRED_ROLES,
	serveScript: (ctx) => senseVoiceServeScript({ model: ctx.roles.model, tokens: ctx.roles.tokens, sampleRate: ctx.sampleRate, maxAudioBytes: ctx.maxAudioBytes }),
	assertWeights: (files) => {
		const problems = assertNoExecutableWeights(files);
		const seen = new Set(files.map((f) => String(f.path).replace(/\\/g, "/")));
		if (![...seen].some((p) => p.endsWith(".onnx"))) problems.push("缺少 onnx 模型文件");
		if (![...seen].some((p) => /(^|\/)tokens\.txt$/.test(p))) problems.push("缺少 tokens.txt");
		return problems;
	},
});

// ------------------------------------------------------------ paraformer

const PARAFORMER_REQUIRED_ROLES = ["model", "tokens"];

registerAsrRunnerFamily({
	id: "paraformer",
	label: "Paraformer（sherpa-onnx）",
	requiredRoles: PARAFORMER_REQUIRED_ROLES,
	serveScript: (ctx) => paraformerServeScript({ model: ctx.roles.model, tokens: ctx.roles.tokens, sampleRate: ctx.sampleRate, maxAudioBytes: ctx.maxAudioBytes }),
	assertWeights: (files) => {
		const problems = assertNoExecutableWeights(files);
		const seen = new Set(files.map((f) => String(f.path).replace(/\\/g, "/")));
		if (![...seen].some((p) => p.endsWith(".onnx"))) problems.push("缺少 onnx 模型文件");
		if (![...seen].some((p) => /(^|\/)tokens\.txt$/.test(p))) problems.push("缺少 tokens.txt");
		return problems;
	},
});

// ------------------------------------------------------------ whisper

const WHISPER_REQUIRED_ROLES = ["encoder", "decoder", "tokens"];

registerAsrRunnerFamily({
	id: "whisper",
	label: "Whisper（sherpa-onnx）",
	requiredRoles: WHISPER_REQUIRED_ROLES,
	serveScript: (ctx) =>
		whisperServeScript({ encoder: ctx.roles.encoder, decoder: ctx.roles.decoder, tokens: ctx.roles.tokens, sampleRate: ctx.sampleRate, maxAudioBytes: ctx.maxAudioBytes }),
	assertWeights: (files) => {
		const problems = assertNoExecutableWeights(files);
		const seen = files.map((f) => String(f.path).replace(/\\/g, "/"));
		if (seen.filter((p) => p.endsWith(".onnx")).length < 2) problems.push("Whisper 需要 encoder + decoder 两个 onnx 文件");
		if (!seen.some((p) => /(^|\/)tokens\.txt$/.test(p))) problems.push("缺少 tokens.txt");
		return problems;
	},
});
