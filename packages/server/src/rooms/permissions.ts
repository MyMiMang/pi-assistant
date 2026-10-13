import { hostSettings, saveHostSettings } from "../host-control.ts";
/** 群专属助理的“操作这台电脑”档位：沿用默认档位，但绝不会是“完全权限” */
export function safeTier(agentId: string) {
	const s = hostSettings();
	const tier = s.defaultTier === "full" ? "bounded" : s.defaultTier;
	saveHostSettings({ tiers: { ...s.tiers, [agentId]: tier } });
}
