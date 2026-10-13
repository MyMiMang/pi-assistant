/**
 * 助理电脑的分配（DESIGN §15.4）：默认所有助理共用一台电脑（SHARED：同一个家目录 = 同样的文件、浏览器登录状态、已装的应用），
 * 选了“单独的电脑”的助理用自己的（容器 / 家目录卷按助理 id 命名，和旧版一致）。
 * 同一台电脑里每个助理可以有自己的屏幕（独立 X 显示器 + VNC + cua-driver），互不抢鼠标键盘；默认大家在主屏幕上。
 * 这里只放纯逻辑（单测覆盖），容器操作在 desktop.ts。
 */
import { safeId } from "./names.ts";
import { desktopSettings, type DesktopSettings } from "./settings.ts";

export const SHARED = "shared";
export const MAIN = "main";
/** 主屏幕“正在被谁用”的有效期：别的助理最近这么久内在主屏幕上操作过，就算主屏幕忙 */
export const MAIN_LEASE_MS = 90_000;

export function computerFor(agentId: string, s: Pick<DesktopSettings, "separate"> = desktopSettings()) {
	return s.separate.includes(agentId) ? safeId(agentId) : SHARED;
}
export const isSharedComputer = (computerId: string) => computerId === SHARED;
/** 某个助理自己的屏幕名（pia-screen 的 key） */
export const ownScreenKey = (agentId: string) => `s-${safeId(agentId)}`.slice(0, 64);

/** 旧版数据迁移：已经有自己电脑家目录卷的现有助理 → 保留为单独的电脑（登录状态不丢）。返回要设为单独电脑的助理 */
export function legacySeparate(volumes: string[], agentIds: string[]): string[] {
	const byId = new Map(agentIds.map((a) => [safeIdOr(a), a] as const).filter(([k]) => k));
	const out: string[] = [];
	for (const v of volumes) {
		const id = /^pia-home-(.+)$/.exec(v.trim())?.[1];
		if (id && id !== SHARED && byId.has(id)) out.push(byId.get(id)!);
	}
	return out;
}
function safeIdOr(a: string) {
	try {
		return safeId(a);
	} catch {
		return "";
	}
}

export interface Lease {
	agentId: string;
	at: number;
}
/**
 * 一个助理要在主屏幕上做会改变屏幕的动作：主屏幕最近被另一个仍在工作的助理用着 → "contention"（给它开自己的屏幕）；
 * 否则 "ok"（并由调用方把主屏幕登记给它）。
 */
export function mainScreenDecision(agentId: string, lease: Lease | undefined, now: number, busy: (agentId: string) => boolean): "ok" | "contention" {
	if (!lease || lease.agentId === agentId) return "ok";
	if (now - lease.at >= MAIN_LEASE_MS) return "ok";
	return busy(lease.agentId) ? "contention" : "ok";
}

/** 屏幕列表给模型 / 界面看的说明 */
export function describeScreens(screens: { key: string; agentId?: string }[], me: string, mine: string, name: (agentId: string) => string) {
	return screens
		.map((s) => {
			const who = s.key === MAIN ? "主屏幕（共用浏览器在这里）" : `${s.agentId ? name(s.agentId) : s.key} 的屏幕`;
			return `${s.key === mine ? "→" : " "} ${who}${s.agentId === me ? "（你的）" : ""}`;
		})
		.join("\n");
}
