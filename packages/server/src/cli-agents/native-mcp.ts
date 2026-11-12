/** 原生 ACP 工具桥传输协商：stdio 是协议基础能力，HTTP 只在明确声明时使用。 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeAcpMcpServers } from "./native-env.ts";

export function nativeMcpTransport(initialize: unknown): "http" | "stdio" {
 const result = initialize as { agentCapabilities?: { mcpCapabilities?: { http?: boolean } } } | null;
 return result?.agentCapabilities?.mcpCapabilities?.http === true ? "http" : "stdio";
}

export function nativeMcpServers(url: string, token: string, initialize: unknown, runDir: string): unknown[] {
 if (nativeMcpTransport(initialize) === "http") return nativeAcpMcpServers(url, token);
 const path = join(runDir, "tool-bridge.json");
 writeFileSync(path, JSON.stringify({ url, token }), { mode: 0o600, flag: "wx" });
 return [{ name: "pia", command: process.execPath,
  args: [fileURLToPath(new URL("./tool-bridge-stdio.mjs", import.meta.url)), path], env: [] }];
}
