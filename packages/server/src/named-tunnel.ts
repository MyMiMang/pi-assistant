/**
 * 固定地址（命名隧道）：用用户自己的 Cloudflare Token，在用户账号里创建 Cloudflare Tunnel（cfd_tunnel，远程配置），
 * ingress 指向 http://127.0.0.1:<port>，再建一条代理的 CNAME <sub>.<zone> → <tunnelId>.cfargotunnel.com，
 * 本机用 `cloudflared tunnel run`（TUNNEL_TOKEN 环境变量）连上。地址固定，不需要 Rendezvous，二维码直接指向它。
 *
 * 所需 Token 权限（在 dash.cloudflare.com/profile/api-tokens 编辑 Token 添加）：
 *   - 账户 › Cloudflare Tunnel › 编辑（Account › Cloudflare Tunnel › Edit）
 *   - 区域 › DNS › 编辑（Zone › DNS › Edit），区域资源包含该域名
 *   - 区域 › 区域 › 读取（Zone › Zone › Read）——“Edit Cloudflare Workers”模板已包含
 */
import { bus } from "./bus.ts";
import { cf, cfToken } from "./cloudflare.ts";
import { config } from "./config.ts";
import { getSetting, setSetting } from "./db.ts";
import { identity } from "./identity.ts";
import { openJson, sealJson } from "./secrets.ts";

export interface NamedTunnel {
	zone: string;
	zoneId: string;
	accountId: string;
	subdomain: string;
	hostname: string;
	tunnelId: string;
	tunnelName: string;
	dnsRecordId: string | null;
	token: string; // sealed
	createdAt: number;
}
export interface PermCheck {
	ok: boolean;
	zone?: { id: string; accountId: string };
	zoneRead: boolean;
	tunnelRead: boolean;
	dnsRead: boolean;
	/** 创建隧道的权限：true/false = 已实测；null = 未实测（只读检查无法确认） */
	tunnelEdit: boolean | null;
	/** 需要用户补充的权限（中文，可直接显示） */
	missing: string[];
	hint?: string;
}

export const PERM_TUNNEL = "账户 › Cloudflare Tunnel › 编辑（Account › Cloudflare Tunnel › Edit）";
export const PERM_DNS = "区域 › DNS › 编辑（Zone › DNS › Edit）";
export const PERM_ZONE = "区域 › 区域 › 读取（Zone › Zone › Read）";
const HOWTO = "在 dash.cloudflare.com → 我的个人资料 → API 令牌 → 编辑你的令牌 → 添加上述权限（区域资源选择该域名）→ 保存，Token 字符串不变，无需重新填写。";

export const namedConfig = () => getSetting<NamedTunnel | null>("namedTunnel", null);
export const namedRunToken = () => {
	const c = namedConfig();
	return c ? openJson<string>(c.token) : null;
};
const isAuthErr = (e: unknown) => {
	const x = e as { status?: number; codes?: number[] };
	return x.status === 403 || x.status === 401 || (x.codes ?? []).some((c) => c === 10000 || c === 9109 || c === 10001);
};

/**
 * 探测 Token 权限。默认只读（不创建任何资源）；probeEdit=true（用户在设置里点“检查权限”时）会建一个临时探测隧道并立即删除，
 * 以确认“Cloudflare Tunnel › 编辑”——只有读取权限时也能列出隧道，单靠只读请求区分不出来。DNS 编辑无法无副作用探测，以读取为准，创建时再精确报错。
 */
export async function checkNamedPerms(zoneName: string, token = cfToken(), opts: { probeEdit?: boolean } = {}): Promise<PermCheck> {
	const res: PermCheck = { ok: false, zoneRead: false, tunnelRead: false, dnsRead: false, tunnelEdit: null, missing: [] };
	if (!token) return { ...res, missing: ["Cloudflare API Token"], hint: "请先在「远程入口」里填写你的 Cloudflare API Token。" };
	try {
		const zs = await cf<{ id: string; account: { id: string } }[]>(token, `/zones?name=${encodeURIComponent(zoneName)}`);
		if (zs[0]) {
			res.zoneRead = true;
			res.zone = { id: zs[0].id, accountId: zs[0].account.id };
		}
	} catch (e) {
		if (!isAuthErr(e)) throw e;
	}
	if (!res.zone) return { ...res, missing: [PERM_ZONE], hint: `这个 Token 看不到域名 ${zoneName}。${HOWTO}` };
	try {
		await cf(token, `/accounts/${res.zone.accountId}/cfd_tunnel?is_deleted=false&per_page=1`);
		res.tunnelRead = true;
	} catch (e) {
		if (!isAuthErr(e)) throw e;
		res.missing.push(PERM_TUNNEL);
	}
	if (res.tunnelRead && opts.probeEdit) {
		try {
			const t = await cf<{ id: string }>(token, `/accounts/${res.zone.accountId}/cfd_tunnel`, { method: "POST", body: JSON.stringify({ name: `pi-assistant-permprobe-${Date.now().toString(36)}`, config_src: "cloudflare" }) });
			res.tunnelEdit = true;
			await cf(token, `/accounts/${res.zone.accountId}/cfd_tunnel/${t.id}`, { method: "DELETE" }).catch(() => {});
		} catch (e) {
			if (!isAuthErr(e)) throw e;
			res.tunnelEdit = false;
			res.missing.push(PERM_TUNNEL);
		}
	}
	try {
		await cf(token, `/zones/${res.zone.id}/dns_records?per_page=1`);
		res.dnsRead = true;
	} catch (e) {
		if (!isAuthErr(e)) throw e;
		res.missing.push(PERM_DNS);
	}
	res.ok = res.missing.length === 0;
	if (!res.ok) res.hint = `固定地址需要给 Token 增加：${res.missing.join("；")}${res.tunnelEdit === null && !res.missing.includes(PERM_TUNNEL) ? `（另请确认已有 ${PERM_TUNNEL}，只读检查无法确认这一项）` : ""}。${HOWTO}`;
	return res;
}

export type SetupStep = { step: string; state: "running" | "ok" | "error"; detail?: string };

/** 创建（或复用）命名隧道 + 远程 ingress 配置 + DNS 记录。失败时回滚本次新建的资源。 */
export async function setupNamedTunnel(input: { zone: string; subdomain: string }): Promise<NamedTunnel> {
	const emit = (s: SetupStep) => bus.emit({ type: "tunnel.setup", ...s } as never);
	const step = async <T>(name: string, fn: () => Promise<T>, detail?: (r: T) => string): Promise<T> => {
		emit({ step: name, state: "running" });
		try {
			const r = await fn();
			emit({ step: name, state: "ok", detail: detail?.(r) });
			return r;
		} catch (e) {
			emit({ step: name, state: "error", detail: e instanceof Error ? e.message : String(e) });
			throw e;
		}
	};
	const token = cfToken();
	if (!token) throw new Error("请先在「远程入口」里填写 Cloudflare API Token");
	const zone = input.zone.trim().toLowerCase();
	const sub = input.subdomain.trim().toLowerCase();
	if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(sub)) throw new Error("子域名只能包含字母、数字和连字符");
	const hostname = `${sub}.${zone}`;
	const perms = await step("检查 Token 权限", () => checkNamedPerms(zone, token, { probeEdit: false }), (p) => (p.ok ? "权限齐全" : p.missing.join("；")));
	if (!perms.ok || !perms.zone) throw Object.assign(new Error(perms.hint ?? "Token 权限不足"), { missing: perms.missing });
	const { id: zoneId, accountId } = perms.zone;
	const tunnelName = `pi-assistant-${identity().serverId.slice(0, 8)}`;
	let createdTunnel: string | null = null;
	try {
		const tunnel = await step(
			"创建隧道",
			async () => {
				const list = await cf<{ id: string; name: string }[]>(token, `/accounts/${accountId}/cfd_tunnel?is_deleted=false&name=${tunnelName}`);
				if (list[0]) return list[0];
				try {
					const t = await cf<{ id: string; name: string }>(token, `/accounts/${accountId}/cfd_tunnel`, { method: "POST", body: JSON.stringify({ name: tunnelName, config_src: "cloudflare" }) });
					createdTunnel = t.id;
					return t;
				} catch (e) {
					if (isAuthErr(e)) throw new Error(`Token 缺少权限：${PERM_TUNNEL}。${HOWTO}`);
					throw e;
				}
			},
			(t) => `${t.name}（${t.id.slice(0, 8)}）`,
		);
		await step("配置转发到本机", () =>
			cf(token, `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/configurations`, {
				method: "PUT",
				body: JSON.stringify({ config: { ingress: [{ hostname, service: `http://127.0.0.1:${config.port}`, originRequest: {} }, { service: "http_status:404" }] } }),
			}),
		);
		const dnsRecordId = await step(
			"创建 DNS 记录",
			async () => {
				const target = `${tunnel.id}.cfargotunnel.com`;
				try {
					const existing = await cf<{ id: string; type: string; content: string }[]>(token, `/zones/${zoneId}/dns_records?name=${hostname}`);
					const same = existing.find((r) => r.type === "CNAME" && r.content === target);
					if (same) return same.id;
					if (existing.length) throw new Error(`${hostname} 已经有 DNS 记录（${existing.map((r) => r.type).join("/")}），请换一个子域名，或先在 Cloudflare 里删除旧记录`);
					const r = await cf<{ id: string }>(token, `/zones/${zoneId}/dns_records`, { method: "POST", body: JSON.stringify({ type: "CNAME", name: hostname, content: target, proxied: true, comment: "Pi Assistant 固定地址（命名隧道）" }) });
					return r.id;
				} catch (e) {
					if (isAuthErr(e)) throw new Error(`Token 缺少权限：${PERM_DNS}。${HOWTO}`);
					if ((e as { codes?: number[] }).codes?.includes(81053)) throw new Error(`${hostname} 已被占用（可能绑定了 Worker 自定义域名），请换一个子域名`);
					throw e;
				}
			},
			() => hostname,
		);
		const runToken = await step("获取隧道凭据", () => cf<string>(token, `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/token`), () => "已加密保存");
		const cfg: NamedTunnel = { zone, zoneId, accountId, subdomain: sub, hostname, tunnelId: tunnel.id, tunnelName, dnsRecordId, token: sealJson(runToken), createdAt: Date.now() };
		setSetting("namedTunnel", cfg);
		setSetting("tunnelMode", "named");
		return cfg;
	} catch (e) {
		if (createdTunnel) await cf(token, `/accounts/${accountId}/cfd_tunnel/${createdTunnel}`, { method: "DELETE" }).catch(() => {});
		throw e;
	}
}

/** 删除固定地址：DNS 记录 + 隧道（先断开连接）。 */
export async function removeNamedTunnel() {
	const c = namedConfig();
	const token = cfToken();
	if (c && token) {
		if (c.dnsRecordId) await cf(token, `/zones/${c.zoneId}/dns_records/${c.dnsRecordId}`, { method: "DELETE" }).catch(() => {});
		await cf(token, `/accounts/${c.accountId}/cfd_tunnel/${c.tunnelId}/connections`, { method: "DELETE" }).catch(() => {});
		await cf(token, `/accounts/${c.accountId}/cfd_tunnel/${c.tunnelId}`, { method: "DELETE" }).catch(() => {});
	}
	setSetting("namedTunnel", null);
	setSetting("tunnelMode", "quick");
}
