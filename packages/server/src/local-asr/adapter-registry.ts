/**
 * 进程内的本地 ASR 端点注册表（**server 内部**，不含凭据持久化）。
 *
 * 为什么单独一层：Pi 的模型运行时只有 chat / image / classifier，**没有 asr**；
 * 用户要求「统一 localASR provider、modeltype asr，不伪 chat/classifier」，且**不自己定义一套 ChatProvider 鉴权**。
 * 因此这里只保存**运行中的本地 ASR 端点描述**（baseUrl + 进程内 token + 采样率），供 voice agent 的
 * `AsrAdapter` 在服务端直接调用；token **只在进程内**，绝不进 `/status`、日志或前端。
 *
 * 多模型：一次只运行一个 worker，但按 **modelId** 索引（provider 只作兼容查询）。
 */
import type { AsrEndpoint } from "./adapter.ts";

/** key = modelId（每个运行中的端点唯一）。 */
const endpoints = new Map<string, AsrEndpoint>();

export function registerAsrEndpoint(e: AsrEndpoint): void {
	endpoints.set(e.modelId, e);
}

export function unregisterAsrEndpoint(providerOrModel: string): void {
	if (endpoints.delete(providerOrModel)) return;
	for (const [k, e] of endpoints) if (e.provider === providerOrModel) endpoints.delete(k);
}

/** 取运行中的端点（含 token）——**只允许服务端内部调用**。传 model 精确匹配，否则按 provider。 */
export function asrEndpoint(provider: string, model?: string | null): AsrEndpoint | undefined {
	if (model) return endpoints.get(model);
	return [...endpoints.values()].find((e) => e.provider === provider);
}

/** 公开视图（不含 token）。 */
export interface AsrPublicEndpoint {
	provider: string;
	modelId: string;
	protocol: string;
	baseUrl: string;
	sampleRate: number;
	languages: string[];
}

export function asrPublicEndpoint(provider: string, model?: string | null): AsrPublicEndpoint | null {
	const e = asrEndpoint(provider, model);
	if (!e) return null;
	const { token: _token, ...rest } = e;
	return rest;
}

/** 测试用：清空。 */
export function resetAsrEndpoints(): void {
	endpoints.clear();
}
