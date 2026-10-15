/**
 * 进程内的本地 ASR 端点注册表（**server 内部**，不含凭据持久化）。
 *
 * 为什么单独一层：Pi 的模型运行时只有 chat / image / classifier，**没有 asr**；
 * 用户要求「统一 localASR provider、modeltype asr，不伪 chat/classifier」，且**不自己定义一套 ChatProvider 鉴权**。
 * 因此这里只保存**运行中的本地 ASR 端点描述**（baseUrl + 进程内 token + 采样率），供 voice agent 的
 * `AsrAdapter` 在服务端直接调用；token **只在进程内**，绝不进 `/status`、日志或前端。
 *
 * 端点的公开视图（`asrPublicStatus`）只暴露 provider / model / protocol / running，用于统一注册表的
 * `type:"asr"` 卡片；凭据一律不出现。
 */
import type { AsrEndpoint } from "./adapter.ts";

const endpoints = new Map<string, AsrEndpoint>();

export function registerAsrEndpoint(e: AsrEndpoint): void {
	endpoints.set(e.provider, e);
}

export function unregisterAsrEndpoint(provider: string): void {
	endpoints.delete(provider);
}

/** 取运行中的端点（含 token）——**只允许服务端内部调用**。 */
export function asrEndpoint(provider: string): AsrEndpoint | undefined {
	return endpoints.get(provider);
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

export function asrPublicEndpoint(provider: string): AsrPublicEndpoint | null {
	const e = endpoints.get(provider);
	if (!e) return null;
	const { token: _token, ...rest } = e;
	return rest;
}

/** 测试用：清空。 */
export function resetAsrEndpoints(): void {
	endpoints.clear();
}
