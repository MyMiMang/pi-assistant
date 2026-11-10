/** 既有只借脑子渠道的私有配置环境；复用原生 ACP 的目录覆盖规则。 */
import { buildNativeAcpEnv, nativeAcpHome, type ManagedCliId } from "./native-env.ts";
import type { ClaudeEnvInput } from "./launch.ts";

export function managedCliEnv(dataDir: string, id: ManagedCliId, input: ClaudeEnvInput = {}): NodeJS.ProcessEnv {
 const home = nativeAcpHome(dataDir, id);
 const fixed: Record<string, string> = id === "claude-code" ? {
  CLAUDE_CONFIG_DIR: home,
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  DISABLE_AUTOUPDATER: "1",
 } : id === "codex" ? { CODEX_HOME: home } : id === "antigravity" ? { AGY_CLI_DISABLE_AUTO_UPDATE: "true" } : {};
 return buildNativeAcpEnv({ ...input, dataDir, id }, fixed);
}
export { nativeAcpHome as managedCliHome };
