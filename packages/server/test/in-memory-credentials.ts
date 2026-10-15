/**
 * 仅测试用：公开 `CredentialStore` 接口的内存实现，**绝不触碰 OS 钥匙串 / 用户凭据 / 真实配置**。
 *
 * 背景：本机出现「找不到用于储存 credential-master-key 钥匙串」系统弹窗。测试若直接构造 server 的
 * 安全凭据后端（`EncryptedCredentialStore`）会走它，从而可能触发钥匙串。这里改为注入纯内存实现，
 * 只实现 Pi 公开的 `CredentialStore`（read/list/modify/delete），语义与真实后端一致、无任何系统调用。
 *
 * 注意：只发给测试；生产代码仍用 server 的安全后端。
 */
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

export function memoryCredentialStore(initial: Record<string, Credential> = {}): CredentialStore {
	const map = new Map<string, Credential>(Object.entries(initial));
	const locks = new Map<string, Promise<unknown>>();
	// 与真实后端一致的“按 provider 串行 read-modify-write”，避免并发测试互相踩。
	const serial = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
		const prev = locks.get(id) ?? Promise.resolve();
		const next = prev.then(fn, fn);
		locks.set(id, next.catch(() => {}));
		return next;
	};
	return {
		read: async (providerId) => map.get(providerId),
		list: async (): Promise<readonly CredentialInfo[]> => [...map.entries()].map(([providerId, c]) => ({ providerId, type: c.type })),
		modify: (providerId, fn) =>
			serial(providerId, async () => {
				const next = await fn(map.get(providerId));
				if (next === undefined) return map.get(providerId);
				map.set(providerId, next);
				return next;
			}),
		delete: (providerId) => serial(providerId, async () => void map.delete(providerId)),
	};
}
