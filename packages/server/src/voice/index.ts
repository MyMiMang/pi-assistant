/**
 * 语音输入（ASR）服务端装配：注册表元数据 + 端点解析 + 路由挂载。
 *
 * 端点解析复用**已有的 provider registry**（Pi 的 models.json / 自定义服务 / 本地 runtime），
 * 凭据走**公开的 `CredentialStore` 接口**（`credentialStore.read`）——本模块**不 import secret.ts**、
 * 不实现 key 解析、不读历史 deny 路径。未知能力不靠模型名猜：只有用户显式声明的 ASR 或本地 runtime
 * 上报的 ASR 才进注册表。
 */
import type { Hono } from "hono";
import { getSetting } from "../db.ts";
import { credentialStore, customProviders, models } from "../models.ts";
import { localModelHints } from "../local-models.ts";
import type { RegistryAsrProvider } from "../model-registry.ts";
import { ASR_ERRORS, ASR_PROTOCOLS, type AsrEndpoint, type AsrSource, type AsrSourceOption, type AsrSourceView } from "./contract.ts";
import { mountAsrStreamRoutes, mountVoiceRoutes } from "./routes.ts";
import { isAsrProtocol, type AsrOutcome } from "./asr.ts";
import { ASR_CATALOG, asrModelSpecByProvider } from "../local-asr/catalog.ts";
import { asrEndpoint } from "../local-asr/adapter-registry.ts";
import { ASR_MODEL_ID, ASR_PROVIDER_ID, localAsrService } from "../local-asr/index.ts";
import { localAsrStreamHub } from "../local-asr/stream-hub.ts";
import { readVoiceSource, readVoiceSourceVersion, withSelected, writeVoiceSource } from "./source.ts";
import { clearDefaultOptOut, writeDefaultOptOut } from "../local-asr/default-voice-prep.ts";

/** 该来源是不是目录里唯一的默认本地语音（数据驱动，不写死 modelId）。 */
function isDefaultVoiceRef(source: AsrSource): boolean {
	const id = localAsrService().defaultVoiceModelId();
	return !!id && source.location === "local" && source.model === id;
}

/** 用户在设置里显式声明的云 ASR 模型（统一注册表 `type:"asr"` 的云来源）。 */
export interface AsrDeclaration {
	provider: string;
	model: string;
	name?: string;
	/** 只认 `openai-audio-transcriptions`；不填按该默认值。 */
	protocol?: string;
	language?: string;
}

const asrDeclarations = (): AsrDeclaration[] => getSetting<AsrDeclaration[]>("asrProviders", []);

/** 把显式声明 + 本地上报合成注册表的 ASR 条目（凭据状态只读，不暴露 key）。 */
export function registryAsrProviders(): RegistryAsrProvider[] {
	const out: RegistryAsrProvider[] = [];
	for (const d of asrDeclarations()) {
		if (!d?.provider || !d?.model) continue;
		const protocol = d.protocol || ASR_PROTOCOLS[0];
		if (!isAsrProtocol(protocol)) continue;
		out.push({ provider: d.provider, modelId: d.model, name: d.name, protocol, configured: providerConfigured(d.provider), location: "cloud", ...(d.language ? { language: d.language } : {}) });
	}
	for (const h of localModelHints()) {
		if (h.type !== "asr") continue;
		out.push({
			provider: h.provider,
			modelId: h.modelId,
			name: h.label,
			protocol: isAsrProtocol(h.protocol) ? h.protocol : ASR_PROTOCOLS[0],
			configured: h.running,
			location: "local",
			local: { installed: h.installed, running: h.running, state: h.state, device: h.device },
		});
	}
	return out;
}

/** 该 provider 是否已配置（只看状态，不读 key 内容；无 key 的自定义服务视为已配置）。 */
function providerConfigured(provider: string): boolean {
	const cp = customProviders.list().find((p) => p.id === provider);
	if (cp?.noKey) return true;
	return !!models.listProviders().find((p) => p.id === provider)?.configured;
}

/** 解析 provider/model → 端点。找不到就 fail-closed（不猜、不用默认 provider、不回落第一个云端）。 */
export async function resolveAsrEndpoint(provider: string, model: string): Promise<AsrOutcome<AsrEndpoint>> {
	// 1) 显式声明的云 ASR
	const decl = asrDeclarations().find((d) => d.provider === provider && d.model === model);
	if (decl) {
		const protocol = decl.protocol || ASR_PROTOCOLS[0];
		if (!isAsrProtocol(protocol)) return { ok: false, code: ASR_ERRORS.notConfigured, status: 400, message: "该语音服务声明的协议不受支持" };
		const baseUrl = baseUrlOf(provider, model);
		if (!baseUrl) return { ok: false, code: ASR_ERRORS.notConfigured, status: 400, message: "该语音服务没有配置地址" };
		const apiKey = await keyOf(provider);
		return { ok: true, value: { protocol, baseUrl, apiKey, location: "cloud" } };
	}
	// 2) 本地 runtime 上报的 ASR（loopback，音频不出设备）：端点（含进程内 token）只在 adapter-registry。
	// 未安装 / 未运行时本地条目也要认得（按目录里的固定 (provider, model) 判断），给明确 409，不回落云端。
	const localSpec = asrModelSpecByProvider(provider, model) ?? (provider === ASR_PROVIDER_ID ? asrModelSpecByProvider(provider, ASR_MODEL_ID) : null);
	if (localSpec) {
		const ep = asrEndpoint(localSpec.provider, localSpec.id) ?? asrEndpoint(localSpec.provider);
		if (!ep) return { ok: false, code: ASR_ERRORS.notConfigured, status: 409, message: "本地语音识别未安装或未运行，请先在语音配置里安装 / 启动" };
		return { ok: true, value: { protocol: "local-asr-http", baseUrl: ep.baseUrl, apiKey: ep.token, location: "local" } };
	}
	return { ok: false, code: ASR_ERRORS.notConfigured, status: 400, message: "请先在设置里选择语音识别模型" };
}

/**
 * 语音来源的候选列表（只读元数据）：云端 = 已声明的 ASR（按 provider 的凭据状态给 availability）；
 * 本地 = catalog 里的所有模型（未安装也出现，但 availability 明确 not_ready）。**不启动 / 不下载 / 不连云。**
 */
export function asrSourceOptions(): AsrSourceOption[] {
	const out: AsrSourceOption[] = [];
	for (const d of asrDeclarations()) {
		if (!d?.provider || !d?.model) continue;
		const protocol = d.protocol || ASR_PROTOCOLS[0];
		if (!isAsrProtocol(protocol)) continue;
		const configured = providerConfigured(d.provider);
		out.push({
			location: "cloud",
			provider: d.provider,
			model: d.model,
			name: d.name || `${d.provider} / ${d.model}`,
			protocol,
			streaming: false,
			streamProtocol: null,
			availability: configured ? "ready" : "not_configured",
			reason: configured ? null : "该服务尚未登录 / 缺少密钥，请先到模型服务配置",
			selected: false,
		});
	}
	// 本地：目录里的每个模型一项（pinned id），状态取该模型的实际 manager。
	const hints = localModelHints();
	for (const spec of ASR_CATALOG) {
		let installed = false;
		let running = false;
		try {
			const st = localAsrService().managerFor(spec.id).status();
			installed = st.install.state === "installed";
			running = st.runtime.state === "running" || st.runtime.state === "starting";
		} catch {
			const h = hints.find((x) => x.type === "asr" && x.provider === spec.provider && x.modelId === spec.id);
			installed = !!h?.installed;
			running = !!h?.running;
		}
		const unsupported = spec.platforms.length > 0 && !spec.platforms.includes(`${process.platform}-${process.arch}`);
		out.push({
			location: "local",
			provider: spec.provider,
			model: spec.id,
			name: spec.name,
			// 流式模型的 protocol 就是流式协议；其余本地模型仍是 batch（local-asr-http）。
			protocol: spec.adapter?.protocol ?? "local-asr-http",
			streaming: spec.streaming === true,
			streamProtocol: spec.streaming === true ? (spec.adapter?.protocol ?? null) : null,
			availability: running ? "ready" : installed ? "not_running" : "not_installed",
			reason: running
				? null
				: unsupported
					? "当前平台不支持该模型"
					: installed
						? "已安装但未运行（开始录音时会自动启动）"
							: spec.license.selfServe
								? "本地语音识别未安装"
								: "该模型未开放本地下载安装，只能自行导入已合法取得的权重",
			selected: false,
		});
	}
	return out;
}

/** 当前来源 + 归一化候选（UI 只读数据；`selected` 只在 `withSelected` 里算，避免多处漂移）。
 * 额外带出默认本地语音的**自动准备状态**（`defaultVoice`），前端在同一个 GET 里读，不另开轮询。 */
export const asrSourceView = (): AsrSourceView => {
	const base = withSelected(readVoiceSource(), asrSourceOptions(), readVoiceSourceVersion());
	return { ...base, defaultVoice: localAsrService().defaultVoicePrepView() };
};
const selectedSourceOptions = () => asrSourceView().options;

/** 来源校验失败（路由层映射成 HTTP 错误；不落库）。 */
export class AsrSourceError extends Error {
	constructor(
		public code: string,
		public status: number,
		message: string,
	) {
		super(message);
	}
}

/** 本地已知的 provider/model（来自 catalog；老配置 provider 也能解析）。 */
function localAsrRefs(): { provider: string; model: string }[] {
	return ASR_CATALOG.map((s) => ({ provider: s.provider, model: s.id }));
}

/** 云：只认**已配置**的声明（未登录的服务不能被选为生效来源）；本地：固定 id 即可选（未安装也能先选意图）。 */
function selectable(source: AsrSource): boolean {
	if (source.location === "local") return localAsrRefs().some((r) => r.provider === source.provider && r.model === source.model);
	return asrDeclarations().some((d) => d.provider === source.provider && d.model === source.model && isAsrProtocol(d.protocol || ASR_PROTOCOLS[0]) && providerConfigured(d.provider));
}

/** 保存显式来源；`null` = 清空（未配置）。未知 / 未配置的 provider-model 抛 `AsrSourceError`，不写库。
 * `opts.expectedVersion` 为跨客户端 CAS：版本不符（另一页面已改选）→ 抛 conflict，不覆盖。 */
export function saveAsrSource(next: AsrSource | null, opts: { expectedVersion?: number } = {}): void {
	if (!next) {
		// 显式清空 = 用户意图「别自动选默认」：记 optout，下次启动不 restart（不靠前端自觉）。
		writeDefaultOptOut("user_cleared");
		writeVoiceSource(null, opts);
		return;
	}
	if (selectable(next)) {
		// 显式选回默认本地模型 → 清掉「别自动装 / 别自动选」标记；选别的模型 → 记 user_chose_other（不自动重启准备）。
		if (isDefaultVoiceRef(next)) clearDefaultOptOut();
		else writeDefaultOptOut("user_chose_other");
		writeVoiceSource(next, opts);
		return;
	}
	const declared = next.location === "cloud" && asrDeclarations().some((d) => d.provider === next.provider && d.model === next.model);
	throw new AsrSourceError(declared ? ASR_ERRORS.notConfigured : ASR_ERRORS.notDeclared, 400, declared ? "该云语音服务尚未配置（缺少密钥），请先到模型服务登录" : "该语音模型不在已声明 / 已知的语音识别列表里");
}

function baseUrlOf(provider: string, model: string): string | undefined {
	const fromCustom = customProviders.list().find((p) => p.id === provider);
	const fromModel = models.getModel(provider, model) as { baseUrl?: string } | undefined;
	const raw = fromCustom?.baseUrl ?? fromModel?.baseUrl;
	return raw ? raw.replace(/\/+$/, "") : undefined;
}

async function keyOf(provider: string): Promise<string | undefined> {
	const store = credentialStore;
	if (!store) return undefined;
	const c = await store.read(provider);
	return c?.type === "api_key" ? c.key : undefined;
}

/** 录音租约：本地 ASR 的 idle 卸载会让路，避免录音中被 kill（最多 60s 录音 ≤ idle 90s，但仍显式持有更稳）。 */
const leases = new Map<string, { release: () => void }>();
let leaseSeq = 0;

async function acquireAsrLease(provider: string, model: string): Promise<{ ok: true; leaseId: string } | { ok: false; code: string; status: number; message: string }> {
	const spec = asrModelSpecByProvider(provider, model) ?? (provider === ASR_PROVIDER_ID ? asrModelSpecByProvider(provider, ASR_MODEL_ID) : null);
	if (!spec) return { ok: false, code: ASR_ERRORS.notConfigured, status: 400, message: "只有本地语音识别需要录音租约" };
	const manager = localAsrService().managerFor(spec.id);
	const st = manager.status();
	if (st.install.state !== "installed") return { ok: false, code: ASR_ERRORS.notConfigured, status: 409, message: "本地语音识别未安装" };
	// 边录边加载：不阻塞录音；启动失败由随后的转写返回 409，UI 再提示。
	void manager.start().catch(() => {});
	const lease = manager.acquireRecording();
	const leaseId = `asr-lease-${++leaseSeq}`;
	leases.set(leaseId, lease);
	return { ok: true, leaseId };
}

function releaseAsrLease(leaseId: string): void {
	const l = leases.get(leaseId);
	if (!l) return;
	l.release();
	leases.delete(leaseId);
}

/** 挂载 ASR 路由（生产装配）。 */
export function mountAsrRoutes(app: Hono<any>) {
	mountVoiceRoutes(app, {
		resolve: resolveAsrEndpoint,
		acquireLease: acquireAsrLease,
		releaseLease: releaseAsrLease,
		source: { read: readVoiceSource, options: selectedSourceOptions, write: saveAsrSource, version: readVoiceSourceVersion, view: asrSourceView },
	});
	// 原生流式会话（start / append / end / cancel）：复用同一 host server 鉴权，不是 loopback-only。
	mountAsrStreamRoutes(app, localAsrStreamHub());
}
