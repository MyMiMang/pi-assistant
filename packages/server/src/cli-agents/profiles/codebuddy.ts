/** CodeBuddy 薄 profile：仅独立 user 设置，保留默认权限模式与工作区规则。 */
import type { AcpProfile } from "../acp-process.ts";
import { buildNativeAcpEnv, nativeAcpHome, nativeAcpMcpServers, prepareNativeAcpHome } from "../native-env.ts";

export const codebuddyProfile: AcpProfile = {
	label: "CodeBuddy",
	mode: "native",
	toolPrefix: "pia_",
	loadParams: { _meta: { "codebuddy.ai/suppressReplay": true } },
	args: () => ["--acp", "--setting-sources", "user", "--strict-mcp-config", "--permission-mode", "default", "--subagent-permission-mode", "default"],
	env: (i) => buildNativeAcpEnv({ ...i, id: "codebuddy" }, { CODEBUDDY_CONFIG_DIR: nativeAcpHome(i.dataDir, "codebuddy"), CODEBUDDY_DISABLE_PARENT_MEMORY: "1", CODEBUDDY_DISABLE_AUTO_MEMORY: "1" }),
	prepare: ({ dataDir }) => {
		prepareNativeAcpHome(dataDir, "codebuddy");
	},
	runFiles: () => [],
	mcpServers: nativeAcpMcpServers,
};
