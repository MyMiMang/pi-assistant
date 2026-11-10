/** 全部受管 CLI 共用一个安装器；清单只来自 third-party.json。 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { NativeInstaller, type NativeRelease } from "./native-install.ts";

const components = JSON.parse(readFileSync(join(import.meta.dirname, "../../../../third-party.json"), "utf8")).components as Array<NativeRelease & { name: string }>;
export function releaseFor(name: string): NativeRelease {
 const release = components.find(c => c.name === name);
 if (!release) throw new Error(`缺少 ${name} 安装清单`);
 return { ...release, packageName: release.name };
}
export const nativeInstaller = new NativeInstaller({ dataDir: config.dataDir, releases: {
 gemini: releaseFor("@google/gemini-cli"), codebuddy: releaseFor("@tencent-ai/codebuddy-code"),
 "claude-code": releaseFor("@anthropic-ai/claude-code"), codex: releaseFor("@openai/codex"), opencode: releaseFor("opencode-ai"),
} });
export function managedArgs(id: "claude-code" | "codex" | "opencode", envName: string): string[] {
 const override = process.env.NODE_ENV !== "production" && (config.mock || process.env.NODE_ENV === "test" || process.env.PIA_DEV === "1") && process.env[`PIA_${envName}`] !== undefined;
 return override ? [] : nativeInstaller.installed(id)?.args ?? [];
}
