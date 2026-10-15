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
import { ASR_ERRORS, ASR_PROTOCOLS, type AsrEndpoint } from "./contract.ts";
import { mountVoiceRoutes } from "./routes.ts";
import { isAsrProtocol, type AsrOutcome } from "./asr.ts";
import { asrEndpoint } from "../local-asr/adapter-registry.ts";
import { asrManager } from "../local-asr/index.ts";

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

/** 解析 provider/model → 端点。找不到就 fail-closed（不猜、不用默认 provider）。 */
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
	const local = localModelHints().find((h) => h.type === "asr" && h.provider === provider && h.modelId === model);
	if (local) {
		const ep = asrEndpoint(provider);
		if (!ep) return { ok: false, code: ASR_ERRORS.notConfigured, status: 409, message: "本地语音服务未运行，请先启动" };
		return { ok: true, value: { protocol: "local-asr-http", baseUrl: ep.baseUrl, apiKey: ep.token, location: "local" } };
	}
	return { ok: false, code: ASR_ERRORS.notConfigured, status: 400, message: "请先在设置里选择语音识别模型" };
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
	const local = localModelHints().find((h) => h.type === "asr" && h.provider === provider && h.modelId === model);
	if (!local) return { ok: false, code: ASR_ERRORS.notConfigured, status: 400, message: "只有本地语音识别需要录音租约" };
	const st = asrManager().status();
	if (st.install.state !== "installed") return { ok: false, code: ASR_ERRORS.notConfigured, status: 409, message: "本地语音识别未安装" };
	// 边录边加载：不阻塞录音；启动失败由随后的转写返回 409，UI 再提示。
	void asrManager().start().catch(() => {});
	const lease = asrManager().acquireRecording();
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
	mountVoiceRoutes(app, { resolve: resolveAsrEndpoint, acquireLease: acquireAsrLease, releaseLease: releaseAsrLease });
}
