import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { managedCliEnv } from "../src/cli-agents/managed-env.ts";
import { buildClaudeEnv } from "../src/cli-agents/launch.ts";
import { buildCodexEnv } from "../src/cli-agents/codex-launch.ts";
import { buildOpencodeEnv, opencodeAuthPath } from "../src/cli-agents/opencode-launch.ts";

test("三家私有环境不继承用户配置路径和密钥，二次白名单不恢复真实HOME", () => {
 const dataDir = mkdtempSync(join(tmpdir(), "pia-managed-env-"));
 try {
  const baseEnv = { HOME: "/user", USERPROFILE: "/user", XDG_CONFIG_HOME: "/user/config", XDG_DATA_HOME: "/user/data", CLAUDE_CONFIG_DIR: "/user/claude", CODEX_HOME: "/user/codex", OPENAI_API_KEY: "forbidden", ANTHROPIC_API_KEY: "forbidden" };
  for (const id of ["claude-code", "codex", "opencode"] as const) {
   const env = id === "opencode" ? buildOpencodeEnv({ dataDir, baseEnv }) : managedCliEnv(dataDir, id, { baseEnv });
   const home = join(dataDir, "cli-agents", id, "home");
   for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) assert.ok(env[key]?.startsWith(home), key);
   assert.equal(env.OPENAI_API_KEY, undefined);
   assert.equal(env.ANTHROPIC_API_KEY, undefined);
   if (id === "claude-code") { assert.equal(env.CLAUDE_CONFIG_DIR, home); assert.equal(buildClaudeEnv({ baseEnv: env }).HOME, home); }
   if (id === "codex") { assert.equal(env.CODEX_HOME, home); assert.equal(buildCodexEnv({ baseEnv: env }).HOME, home); }
   if (id === "opencode") assert.ok(opencodeAuthPath(env, null)?.startsWith(home));
  }
 } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
