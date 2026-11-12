状态：候选已实现；静态供应链和离线测试，真实工具未验证（2026-11-12）

# ACP 第二批固定来源与隔离证据

固定注册表快照：[`4e23bad29bbbcc0d4bf8ee4fa358b5f952b637c7`](https://github.com/agentclientprotocol/registry/tree/4e23bad29bbbcc0d4bf8ee4fa358b5f952b637c7)。运行时使用 third-party.json 固定清单。Cursor / Devin 十二个包全部从官方地址下载后实算 SHA256，属于开发时计算，未执行；其余 binary 使用注册表摘要，npm 使用官方 SHA512。原始研究文件在 artifacts/acp-batch2-research/，本文件保留可重新取得的正式来源。

统一使用私有 HOME / USERPROFILE / APPDATA / LOCALAPPDATA / XDG，环境白名单不带用户模型密钥。目录隔离不能保证系统钥匙串、企业强制配置、云凭据或工作区 / 祖先规则隔离；未知不视为已验证。认证由实际 initialize 协商，API-key-only 仅提示在工具里配置。

| 工具 | 固定包 / 版本 / 校验来源 | 配置变量证据 | 更新证据 |
|---|---|---|---|
| github-copilot-cli | `@github/copilot@1.0.107`；官方 npm SHA512；[注册表](https://github.com/agentclientprotocol/registry/blob/4e23bad29bbbcc0d4bf8ee4fa358b5f952b637c7/github-copilot-cli/agent.json) | verified-current-docs | verified-current-docs |
| grok-build | `@xai-official/grok@1.0.79`；官方 npm SHA512；[注册表](https://github.com/agentclientprotocol/registry/blob/4e23bad29bbbcc0d4bf8ee4fa358b5f952b637c7/grok-build/agent.json) | verified-current-docs | verified-current-docs |
| cursor | `cursor@2026.11.05`；官方地址下载实算 SHA256；[注册表](https://github.com/agentclientprotocol/registry/blob/4e23bad29bbbcc0d4bf8ee4fa358b5f952b637c7/cursor/agent.json) | unknown | unknown |
| amp-acp | `amp-acp@0.12.0`；注册表 SHA256；独立官方 runtime `0.0.1794441653-gbe68d4`，五平台官方 SHA256；[注册表](https://github.com/agentclientprotocol/registry/blob/4e23bad29bbbcc0d4bf8ee4fa358b5f952b637c7/amp-acp/agent.json) | verified-fixed-adapter / fixed-runtime-static | verified-current-docs / fixed-runtime-static |
| devin | `devin@3000.12.32`；官方地址下载实算 SHA256；[注册表](https://github.com/agentclientprotocol/registry/blob/4e23bad29bbbcc0d4bf8ee4fa358b5f952b637c7/devin/agent.json) | partially-verified | verified-current-docs |
| goose | `goose@1.57.0`；注册表 SHA256；[注册表](https://github.com/agentclientprotocol/registry/blob/4e23bad29bbbcc0d4bf8ee4fa358b5f952b637c7/goose/agent.json) | verified-fixed-source | unknown |
| auggie | `@augmentcode/auggie@0.37.0`；官方 npm SHA512；[注册表](https://github.com/agentclientprotocol/registry/blob/4e23bad29bbbcc0d4bf8ee4fa358b5f952b637c7/auggie/agent.json) | partially-verified | verified-fixed-registry |
| autohand | `autohand@0.9.10`；注册表 SHA256；[注册表](https://github.com/agentclientprotocol/registry/blob/4e23bad29bbbcc0d4bf8ee4fa358b5f952b637c7/autohand/agent.json) | verified-fixed-source | verified-fixed-source |
| cline | `cline@3.0.74`；官方 npm SHA512；[注册表](https://github.com/agentclientprotocol/registry/blob/4e23bad29bbbcc0d4bf8ee4fa358b5f952b637c7/cline/agent.json) | verified-matching-version-main | verified-matching-version-main |
| factory-droid | `droid@1.6.0`；官方 npm SHA512；[注册表](https://github.com/agentclientprotocol/registry/blob/4e23bad29bbbcc0d4bf8ee4fa358b5f952b637c7/factory-droid/agent.json) | unknown | verified-fixed-registry |
| kilo | `kilo@7.8.27`；注册表 SHA256；[注册表](https://github.com/agentclientprotocol/registry/blob/4e23bad29bbbcc0d4bf8ee4fa358b5f952b637c7/kilo/agent.json) | verified-fixed-source | verified-fixed-source |
| kimi-code | `@moonshot-ai/kimi-code@2.5.2`；官方 npm SHA512；[注册表](https://github.com/agentclientprotocol/registry/blob/4e23bad29bbbcc0d4bf8ee4fa358b5f952b637c7/kimi-code/agent.json) | verified-fixed-package | verified-newer-matching-main |
| kiro | `kiro@3.0.0`；注册表 SHA256；[注册表](https://github.com/agentclientprotocol/registry/blob/4e23bad29bbbcc0d4bf8ee4fa358b5f952b637c7/kiro/agent.json) | unknown | unknown |
| mistral-vibe | `mistral-vibe@3.1.0`；注册表 SHA256；[注册表](https://github.com/agentclientprotocol/registry/blob/4e23bad29bbbcc0d4bf8ee4fa358b5f952b637c7/mistral-vibe/agent.json) | verified-fixed-source | verified-newer-source |
| qwen-code | `@qwen-code/qwen-code@0.27.0`；官方 npm SHA512；[注册表](https://github.com/agentclientprotocol/registry/blob/4e23bad29bbbcc0d4bf8ee4fa358b5f952b637c7/qwen-code/agent.json) | verified-fixed-source | verified-fixed-source |

## 逐家证据与适用边界

### github-copilot-cli

- 配置：`{"COPILOT_HOME":"<private-home>/.copilot","COPILOT_CACHE_HOME":"<private-cache>"}`；verified-current-docs。[来源1](https://docs.github.com/en/copilot/reference/cli-command-reference)。Official docs override configuration/state and cache separately; fixed 1.0.107 implementation not inspected.
- 更新：`{"args":["--no-auto-update"]}`；verified-current-docs。[来源1](https://docs.github.com/en/copilot/reference/cli-command-reference)。Disables update and running a newer cached binary; fixed-version presence not verified.
- 认证：`{"terminalCommand":["copilot","login"],"apiKeyEnv":["COPILOT_GITHUB_TOKEN","GH_TOKEN","GITHUB_TOKEN"],"acpType":"unknown"}`；partially-verified。[来源1](https://docs.github.com/en/copilot/reference/cli-command-reference)；[来源2](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)。Official ACP docs require pre-authenticated GitHub or BYOK and say /login does not work over ACP. Exact initialize method type remains unknown; do not label Agent Auth merely from interactive login.
- 工具桥：`未核实`；unknown。[来源1](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)。General MCP HTTP support is documented, but no fixed-version initialize HTTP declaration obtained. Existing native HTTP gate must remain authoritative.
- 边界：Current docs: system keychain is used, plaintext fallback under COPILOT_HOME; changing directory does not prove keychain namespace isolation.
- 边界：Workspace rules, MCP, GitHub tooling and OS credential helpers remain outside directory-only isolation.

### grok-build

- 配置：`{"GROK_HOME":"<private-home>/.grok"}`；verified-current-docs。[来源1](https://docs.x.ai/build/settings/reference)；[来源2](https://registry.npmjs.org/@xai-official/grok/-/grok-1.0.82.tgz)。Docs cover config/auth/sessions/skills/plugins/logs; launcher also installs into GROK_HOME/bin. Fixed 1.0.79 not inspected.
- 更新：`{"env":{"GROK_DISABLE_AUTOUPDATER":"1"},"alternativeArgs":["--no-auto-update"]}`；verified-current-docs。[来源1](https://docs.x.ai/build/settings/reference)；[来源2](https://docs.x.ai/build/cli/headless-scripting)。
- 认证：`{"acpType":"unknown","apiKeyEnv":["XAI_API_KEY"],"preAuthenticatedCli":true}`；partially-verified。[来源1](https://docs.x.ai/build/cli/headless-scripting)；[来源2](https://docs.x.ai/build/overview)。ACP examples assume browser login was completed locally, or XAI_API_KEY is set. No initialize auth method captured.
- 工具桥：`未核实`；unknown。[来源1](https://docs.x.ai/build/settings/reference)。HTTP/SSE endpoints supported in ordinary MCP settings; ACP initialize declaration still unknown.
- 边界：Reads /etc/grok/managed_config.toml and /etc/grok/requirements.toml, also /etc/claude-code/managed-settings.json compatibility policy. HOME cannot hide system policy.
- 边界：Cursor/Claude compatibility scanners default on; GROK_CURSOR_SKILLS_ENABLED, GROK_CURSOR_MCPS_ENABLED, GROK_CLAUDE_MCPS_ENABLED documented; workspace and ancestor discoveries still require review.
- 边界：npm loader may redirect to GROK_HOME/bin; private installation alone does not prevent mutable runtime bootstrap.
- 边界：Registry calls product proprietary; npm bootstrap metadata says Apache-2.0. Do not extend bootstrap license to native Grok runtime.

### cursor

- 配置：`未核实`；unknown。[来源1](https://cursor.com/docs/cli/reference/configuration)。No tool-specific config override proven; generic HOME/XDG is the baseline only.
- 更新：`未核实`；unknown。[来源1](https://cursor.com/docs/cli/reference/environment-variables)。Official docs fetch TLS failures; no disable-update variable guessed.
- 认证：`未核实`；unknown。[来源1](https://cursor.com/docs/cli/acp)。Agent Auth vs terminal auth and API-key contract not verified for fixed release.
- 工具桥：`未核实`；unknown。[来源1](https://cursor.com/docs/cli/acp)。No fixed-version HTTP MCP capability obtained.
- 边界：Keychain/OS identity stores and project Cursor settings may remain shared; unverified.
- 边界：固定注册表没有厂商发布的 SHA256；本批已下载六个平台文件并实算固定摘要，未取得独立厂商摘要作二次比对。

### amp-acp

- 配置：`{"AMP_ACP_STATE_DIR":"<private-state>/amp-acp","AMP_CLI_PATH":"<private-managed-amp-binary>"}`；verified-fixed-adapter。[来源1](https://github.com/tao12345666333/amp-acp/blob/v0.12.0/README.md)。Adapter state override only. Required Amp CLI has its own config/auth and license, not bundled by this registry entry.
- 官方 runtime：`amp-cli-runtime@0.0.1794441653-gbe68d4`，与适配器独立管理。[官方 shell](https://ampcode.com/install.sh)、[官方 PowerShell](https://ampcode.com/install.ps1)、[固定 npm 元数据](https://registry.npmjs.org/@ampcode/cli/0.0.1794441653-gbe68d4) 均给出五平台，直接下载未压缩 binary，SHA 对应该文件。先 runtime 后 adapter，两者准备好才启动；不运行供应脚本，不扫描宿主 Amp。官方没有 native Windows ARM64，卡片明确不支持。
- 固定前缀 `https://static.ampcode.com/cli/0.0.1794441653-gbe68d4/`：文件名为 `amp-darwin-arm64`、`amp-darwin-x64`、`amp-linux-arm64`、`amp-linux-x64`、`amp-windows-x64.exe`；对应官方摘要文件 `<platform>-amp.sha256`（Windows 平台名 `windows-x64`）。完整 URL/SHA 固定于 third-party.json。Mac ARM64 固定 npm 包 SHA512 及内含 binary 官方 SHA256 已静态比对；其他四平台仅 HEAD 与官方摘要，未执行。
- 更新：强制 `AMP_SKIP_UPDATE_CHECK=1`、私有 `AMP_SETTINGS_FILE`；settings 写 `amp.updates.mode=disabled`、`amp.runner.autoUpdate.enabled=false`。[官方设置](https://ampcode.com/docs/markdown/cli/settings) 与固定 runtime 静态帮助/禁更字符串共同支持；关闭检查不禁用手工 `amp update`。适配器不另猜禁更变量，用户显式更新当前只检查 App 固定清单。
- 认证：`{"types":["terminal","legacy-terminal"],"terminalArgs":["--setup"],"apiKeyEnv":["AMP_API_KEY"],"manualCommand":["amp","login"]}`；verified-fixed-adapter。[来源1](https://github.com/tao12345666333/amp-acp/blob/v0.12.0/README.md)。Standard auth when clientCapabilities.auth.terminal is true; legacy _meta terminal-auth fallback; --setup is interactive API-key fallback. Not Agent Auth browser OAuth.
- 工具桥：`true`；verified-fixed-docs。[来源1](https://github.com/tao12345666333/amp-acp/blob/v0.12.0/README.md)；[来源2](https://github.com/tao12345666333/amp-acp/blob/v0.12.0/docs/mcp-passthrough.md)。README explicitly supports HTTP/SSE pass-through; actual initialize packet not executed.
- 边界：Third-party wrapper, not first-party Amp. Requires installed authenticated Amp CLI and shares its credentials by default.
- 边界：已提供私有 Amp runtime 并强制绝对 AMP_CLI_PATH；固定 runtime 与 adapter 兼容性仍未实际运行验证。
- 边界：固定 runtime 存在 keyring 实现，未证实独立凭据 namespace；私有 HOME/XDG/settings 不保证系统钥匙串隔离，也不屏蔽工作区/祖先及企业 managed-settings。未知写入 Help，不新增安装门槛。Linux musl 未验证。
- 边界：Apache-2.0 仅覆盖 adapter；runtime 包许可证 © Sourcegraph Inc. All rights reserved，适用 [Amp 条款](https://ampcode.com/terms)。仅用户按需从官方地址下载，不随 App 再分发。

### devin

- 配置：`{"documentedConfig":"~/.config/devin/config.json","dedicatedEnv":null}`；partially-verified。[来源1](https://docs.devin.ai/cli/reference/configuration/config-file)。No dedicated config-directory override established; rely only on already-approved generic private HOME/XDG, not a guessed DEVIN_HOME.
- 更新：`{"config":{"auto_update":false},"file":"~/.config/devin/config.json"}`；verified-current-docs。[来源1](https://docs.devin.ai/cli/reference/configuration/config-file)。Explicit auto_update config is documented; env disable and fixed 3000.12.32 behavior unknown.
- 认证：`{"acpType":"agent-browser"}`；verified-current-docs。[来源1](https://docs.devin.ai/cli/acp/zed)。Authenticate/Reauthenticate opens browser login; exact method id and fixed-version response unknown.
- 工具桥：`未核实`；unknown。[来源1](https://docs.devin.ai/cli/extensibility/mcp/configuration)。Official MCP configuration index describes stdio/Streamable HTTP/SSE generally; ACP initialize declaration not obtained.
- 边界：Project .devin config and cross-tool imports/rules remain; host OS identity-store behavior unverified.
- 边界：固定注册表没有厂商发布的 SHA256；本批已下载六个平台文件并实算固定摘要，未取得独立厂商摘要作二次比对。

### goose

- 配置：`{"GOOSE_PATH_ROOT":"<private-absolute-root>","GOOSE_DISABLE_KEYRING":"1"}`；verified-fixed-source。[来源1](https://github.com/block/goose/blob/v1.57.0/crates/goose/src/config/paths.rs)；[来源2](https://github.com/block/goose/blob/v1.57.0/crates/goose/src/config/base.rs)。Fixed 1.57.0 paths.rs confirms absolute GOOSE_PATH_ROOT mapping; base.rs confirms presence-based GOOSE_DISABLE_KEYRING check.
- 更新：`未核实`；unknown。[来源1](https://github.com/block/goose/tree/v1.57.0/crates/goose-cli)。No specific automatic self-update disable switch established; do not invent GOOSE_NO_UPDATE.
- 认证：`{"acpType":"agent","id":"goose-provider","manualCommand":["goose","configure"]}`；verified-fixed-source。[来源1](https://github.com/block/goose/blob/v1.57.0/crates/goose/src/acp/server.rs)。Fixed 1.57.0 initialize advertises Agent goose-provider with description run goose configure; browser auth completion remains unverified.
- 工具桥：`true`；verified-fixed-source。[来源1](https://github.com/block/goose/blob/v1.57.0/crates/goose/src/acp/server.rs)。Fixed 1.57.0 initialize explicitly declares McpCapabilities::new().http(true).
- 边界：Default OS keyring is shared across private directory roots unless disabled; disabling changes backend to private file storage.
- 边界：External providers (AWS/Azure/GitHub/OAuth/custom commands) may use separate OS/cloud credential mechanisms.

### auggie

- 配置：`{"documentedHome":"~/.augment","dedicatedEnv":null}`；partially-verified。[来源1](https://unpkg.com/@augmentcode/auggie@0.37.0/augment.mjs)。Bundle uses os home for .augment; no AUGMENT_CONFIG_DIR proven. Do not mistake AUGMENT_VFS_DIR for auth/config home.
- 更新：`{"env":{"AUGMENT_DISABLE_AUTO_UPDATE":"1"}}`；verified-fixed-registry。[来源1](https://github.com/agentclientprotocol/registry/blob/4e23bad29bbbcc0d4bf8ee4fa358b5f952b637c7/auggie/agent.json)；[来源2](https://unpkg.com/@augmentcode/auggie@0.37.0/augment.mjs)。
- 认证：`{"manualCommand":["auggie","login"],"authEnv":["AUGMENT_SESSION_AUTH"],"acpType":"unknown"}`；partially-verified。[来源1](https://unpkg.com/@augmentcode/auggie@0.37.0/augment.mjs)；[来源2](https://docs.augmentcode.com/cli/v0/acp/agent)。AUGMENT_SESSION_AUTH contains OAuth session JSON, not a generic API-key integration; do not copy/inherit host session.
- 工具桥：`未核实`；unknown。[来源1](https://docs.augmentcode.com/cli/v0/acp/agent)。Downloaded bundle only exposes SDK defaults in inspected portion; defaults false are not agent capability evidence. Actual initialize HTTP flag unresolved.
- 边界：HOME does not prove all OS identity and enterprise tenant state isolated.
- 边界：Native MCP/server and cloud/daemon processes may have additional config; fixed standalone ACP behavior not run.

### autohand

- 配置：`{"AUTOHAND_HOME":"<private-home>/.autohand"}`；verified-fixed-source。[来源1](https://github.com/autohandai/code-cli/blob/v0.9.10/src/constants.ts)。Root includes config/sessions/history/skills/cache; project .autohand remains under workspace.
- 更新：`{"env":{"AUTOHAND_SKIP_UPDATE_CHECK":"1"}}`；verified-fixed-source。[来源1](https://github.com/autohandai/code-cli/blob/v0.9.10/src/utils/versionCheck.ts)。Skips version checks; explicit update command deliberately removes it. Does not disable separately fetched model catalogs.
- 认证：`{"acpType":"terminal","id":"autohand-setup","args":["--setup"]}`；verified-fixed-source。[来源1](https://github.com/autohandai/code-cli/blob/v0.9.10/src/modes/acp/adapter.ts)。Method tells host to configure model and auth interactively; provider API keys are handled by Autohand setup, not Pi.
- 工具桥：`true`；verified-fixed-source。[来源1](https://github.com/autohandai/code-cli/blob/v0.9.10/src/modes/acp/adapter.ts)。initialize mcpCapabilities http:true,sse:true.
- 边界：System/project files, provider helpers and child processes are not sandboxed by HOME.
- 边界：Autohand can use Codex-compatible skill helper environment; ensure private child roots remain private.

### cline

- 配置：`{"CLINE_DIR":"<private-home>/.cline","CLINE_DATA_DIR":"<private-home>/.cline/data"}`；verified-matching-version-main。[来源1](https://github.com/cline/cline/blob/main/apps/cli/src/commands/config.ts)；[来源2](https://github.com/cline/cline/blob/main/apps/cli/README.md)。Downloaded main package.json says 3.0.74, matching fixed registry, but main is mutable and release binary equivalence unproven.
- 更新：`{"env":{"CLINE_NO_AUTO_UPDATE":"1"}}`；verified-matching-version-main。[来源1](https://github.com/cline/cline/blob/main/apps/cli/src/commands/update.ts)。
- 认证：`{"acpType":"agent","ids":["cline","cline-pass","openai-codex"],"apiKeyEnv":["CLINE_API_KEY"]}`；verified-matching-version-main。[来源1](https://github.com/cline/cline/blob/main/apps/cli/src/acp/acpAgent.ts)；[来源2](https://github.com/cline/cline/blob/main/apps/cli/src/acp/auth.ts)。OAuth methods open browser. Exact optional list may change.
- 工具桥：`false`；verified-matching-version-main。[来源1](https://github.com/cline/cline/blob/main/apps/cli/src/acp/acpAgent.ts)。initialize 未声明 HTTP；本批用标准 stdio 转发到同一工具桥，真实固定发行包未执行。
- 边界：本批已接标准 stdio 转发，复用既有 HTTP 工具桥与审批/取消流程；离线假程序通过不代表固定 Cline 真实运行已验。
- 边界：Config/data roots are separate; OS/provider auth and external daemon namespaces not proven isolated.

### factory-droid

- 配置：`未核实`；unknown。[来源1](https://docs.factory.com/droid-cli/settings)。No FACTORY_HOME / FACTORY_CONFIG_DIR proven. Generic HOME/XDG only; current docs settings are not sufficient directory override evidence.
- 更新：`{"env":{"DROID_DISABLE_AUTO_UPDATE":"true","FACTORY_DROID_AUTO_UPDATE_ENABLED":"false"}}`；verified-fixed-registry。[来源1](https://github.com/agentclientprotocol/registry/blob/4e23bad29bbbcc0d4bf8ee4fa358b5f952b637c7/factory-droid/agent.json)。Both present in fixed 1.6.0 registry, not inferred from 1.8.0 npm metadata.
- 认证：`未核实`；unknown。[来源1](https://docs.factory.com/droid-cli/settings)。No exact fixed ACP auth methods or API-key contract established; FACTORY_API_KEY must not be assumed solely from product familiarity.
- 工具桥：`未核实`；unknown。[来源1](https://docs.factory.com/harness/mcp)。No fixed 1.6.0 ACP initialize HTTP MCP declaration obtained.
- 边界：Private HOME does not prove keychain isolation or enterprise managed policies; unknown.
- 边界：npm package metadata UNLICENSED means no open license grant, not permission to redistribute runtime.

### kilo

- 配置：`{"KILO_CONFIG_DIR":"<private-config>/kilo","usesExistingPrivateXdg":true}`；verified-fixed-source。[来源1](https://github.com/Kilo-Org/kilocode/blob/v7.8.27/packages/core/src/flag/flag.ts)；[来源2](https://github.com/Kilo-Org/kilocode/blob/v7.8.27/packages/core/src/global.ts)。KILO_CONFIG_DIR relocates config only; data/cache/state still XDG. KILO_TEST_HOME is a test hook, not recommended production isolation contract.
- 更新：`{"env":{"KILO_DISABLE_AUTOUPDATE":"1"}}`；verified-fixed-source。[来源1](https://github.com/Kilo-Org/kilocode/blob/v7.8.27/packages/core/src/flag/flag.ts)；[来源2](https://github.com/Kilo-Org/kilocode/blob/v7.8.27/packages/opencode/src/cli/upgrade.ts)。
- 认证：`{"acpType":"legacy-terminal","id":"kilo-login","legacyCommand":"opencode","legacyArgs":["auth","login"],"documentedCommand":["kilo","auth","login"]}`；verified-fixed-source。[来源1](https://github.com/Kilo-Org/kilocode/blob/v7.8.27/packages/opencode/src/acp/service.ts)。BUG/limitation: legacy metadata command is opencode, while description is kilo auth login. authenticate only returns {}; it does not complete browser auth. Enforce managed-command check; do not execute host opencode.
- 工具桥：`true`；verified-fixed-source。[来源1](https://github.com/Kilo-Org/kilocode/blob/v7.8.27/packages/opencode/src/acp/service.ts)。http:true,sse:true.
- 边界：Fixed upstream login metadata references another product executable; reject rather than silently run host CLI.
- 边界：Global tmp uses OS tmp/kilo rather than XDG; profile directory alone is not full process isolation.

### kimi-code

- 配置：`{"KIMI_CODE_HOME":"<private-home>/.kimi-code"}`；verified-fixed-package。[来源1](https://unpkg.com/@moonshot-ai/kimi-code@2.5.2/dist/main.mjs)。Fixed 2.5.2 published bundle contains KIMI_CODE_HOME resolution; os home fallback .kimi-code. No main-to-fixed inference used for this claim.
- 更新：`{"env":{"KIMI_CODE_NO_AUTO_UPDATE":"1"}}`；verified-newer-matching-main。[来源1](https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/src/cli/update/preflight.ts)。KIMI_CODE_NO_AUTO_UPDATE is confirmed only in newer 2.5.3 main preflight source; not found in inspected 2.5.2 published bundle portion. Fixed support remains UNKNOWN; do not promote this env to fixed 2.5.2 profile automatically.
- 认证：`{"acpType":"terminal","id":"login","args":["--login"],"env":"top-level string map; same private root","legacy":{"command":"configured absolute binary","args":["login"]}}`；verified-fixed-package。[来源1](https://unpkg.com/@moonshot-ai/kimi-code@2.5.2/dist/main.mjs)。Fixed bundle buildTerminalAuthMethod sets first-class args [--login]; append to managed base invocation -> kimi acp --login. Legacy args [login] replace ACP subcommand, producing kimi login. acp command explicitly defines --login flag.
- 工具桥：`true`；verified-fixed-package。[来源1](https://unpkg.com/@moonshot-ai/kimi-code@2.5.2/dist/main.mjs)。Fixed 2.5.2 published bundle agent initialize explicitly declares http:true,sse:true; SDK defaults elsewhere were not used as evidence.
- 边界：Fixed 2.5.2 package evidence now confirms isolation/auth/HTTP; update disable remains newer-main-only.
- 边界：Project config/plugins/helper imports remain; directory controls do not isolate remote account.

### kiro

- 配置：`未核实`；unknown。[来源1](https://kiro.dev/docs/cli/acp/)。No KIRO_CONFIG_DIR or KIRO_HOME proven for CLI 3.0.0; generic HOME/XDG cannot guarantee OS-home API confinement.
- 更新：`未核实`；unknown。[来源1](https://kiro.dev/docs/cli/)。No CLI 3.0.0 disable-auto-update contract verified; do not infer IDE auto-update setting.
- 认证：`{"acpType":"terminal","manualCommand":["kiro-cli","login"],"reconnectAfterLogin":true}`；verified-current-docs。[来源1](https://kiro.dev/docs/cli/acp/)。Official page says accepts clientCapabilities.auth.terminal and legacy _meta terminal-auth; page also contains legacy CLI v2 material, exact 3.0.0 packet not captured.
- 工具桥：`未核实`；unknown。[来源1](https://kiro.dev/docs/cli/acp/)。Page says MCP can be passed to sessions but does not prove HTTP initialize declaration for v3.
- 边界：No Windows binary in fixed registry.
- 边界：System login/keychain/AWS SSO cache behavior may cross HOME; not verified.

### mistral-vibe

- 配置：`{"VIBE_HOME":"<private-home>/.vibe"}`；verified-fixed-source。[来源1](https://github.com/mistralai/mistral-vibe/blob/v3.1.0/vibe/utils/vibe_home.py)。Fixed 3.1.0 vibe/utils/vibe_home.py confirms VIBE_HOME. Fixed agent/config fetches were truncated before initialize/config setting; HTTP/auth/update remain newer-source evidence only.
- 更新：`{"config":{"enable_update_checks":false}}`；verified-newer-source。[来源1](https://github.com/mistralai/mistral-vibe/blob/v3.1.1/vibe/core/config/vibe_schema.py)；[来源2](https://github.com/mistralai/mistral-vibe/blob/v3.1.1/vibe/cli-rust/src/update_flow.rs)。Configuration switch controls startup update checks; no invented VIBE_DISABLE_AUTO_UPDATE. Fixed ACP standalone startup path not proven.
- 认证：`{"acpType":["agent-browser","terminal-legacy-gated"],"terminalArgs":["--setup"],"apiKeyEnv":["MISTRAL_API_KEY"]}`；verified-newer-source。[来源1](https://github.com/mistralai/mistral-vibe/blob/v3.1.1/vibe/acp/agent.py)；[来源2](https://github.com/mistralai/mistral-vibe/blob/v3.1.1/vibe/acp/auth.py)。Terminal method only when legacy client meta terminal-auth advertised; source also supports browser auth. Host needs actual initialize method negotiation.
- 工具桥：`false`；verified-newer-source。[来源1](https://github.com/mistralai/mistral-vibe/blob/v3.1.1/vibe/acp/agent.py)。新版未声明 HTTP，固定 3.1.0 声明未知；本批按实际握手在 HTTP 与标准 stdio 转发间选择，真实发行包未执行。
- 边界：VIBE_HOME/.env intentionally loads API keys; do not overwrite existing private files or import real home.
- 边界：Separate credentials backend/cloud SSO isolation not proven.

### qwen-code

- 配置：`{"QWEN_HOME":"<private-home>/.qwen"}`；verified-fixed-source。[来源1](https://github.com/QwenLM/qwen-code/blob/v0.27.0/packages/core/src/config/storage.ts)。Fixed 0.27.0 Storage reads QWEN_HOME as the global .qwen directory itself.
- 更新：`{"config":{"general":{"enableAutoUpdate":false}},"optionalPerProcessEnv":{"QWEN_CODE_SKIP_UPDATE_CHECK_ONCE":"true"}}`；verified-fixed-source。[来源1](https://github.com/QwenLM/qwen-code/blob/v0.27.0/packages/cli/src/config/settingsSchema.ts)；[来源2](https://github.com/QwenLM/qwen-code/blob/v0.27.0/packages/cli/src/utils/processUtils.ts)。Fixed settingsSchema confirms general.enableAutoUpdate; processUtils confirms QWEN_CODE_SKIP_UPDATE_CHECK_ONCE. This ONCE variable is not a blanket daemon update contract.
- 认证：`{"acpType":"api-key / vendor-meta-terminal","apiKeyEnv":["OPENAI_API_KEY"],"meta":{"type":"terminal","args":["--auth-type=openai"]}}`；verified-fixed-source。[来源1](https://github.com/QwenLM/qwen-code/blob/v0.27.0/packages/cli/src/acp-integration/authMethods.ts)。Fixed 0.27.0 authMethods only advertises openai API-key method with vendor _meta.type terminal / _meta.args. Neither supported first-class nor legacy terminal-auth shape; API-key limitation, not browser login.
- 工具桥：`true`；verified-fixed-source。[来源1](https://github.com/QwenLM/qwen-code/blob/v0.27.0/packages/cli/src/acp-integration/acpAgent.ts)。Fixed 0.27.0 initialize explicitly declares http:true,sse:true.
- 边界：System settings, workspace .qwen settings and upward .env discovery remain.
- 边界：Provider keys and Qwen auth choices differ by versions; fixed auth schema must be read before promotion.

## 当前实现取舍与阻塞

- Amp 官方 runtime 已固定五平台供应与官方 SHA，复用 NativeInstaller 先 runtime 后 adapter；缺任一产物不就绪，取消保留旧 current。供应 missing 限制已解除，钥匙串隔离及固定组合实际运行仍未验证。定向离线测试见 artifacts/amp-runtime-tests.log（82/82）；真实安装、登录与付费请求均未执行。
- Cline / Mistral Vibe 的所查初始化源码没有 HTTP MCP 声明；Vibe 固定版本声明仍未知。现按真实握手协商：声明 HTTP 则直连，否则使用 ACP 标准 stdio 定义，由 App Node 转发到原有 HTTP 工具桥。执行、审批和取消仍复用原流程；离线定向测试通过，真实工具未运行。
- Kilo 固定旧式 terminal metadata 错指 opencode。认证仍使用受管 Kilo，采用同一固定源码说明的 kilo auth login；不会执行用户 opencode。
- Qwen 固定认证为 API key / 厂商自定义 meta；不把非标准元数据冒充浏览器登录，提示在工具里配置。
- Kimi 固定 2.5.2 已验证 KIMI_CODE_HOME 与 terminal --login；新版 KIMI_CODE_NO_AUTO_UPDATE 未编入固定配置，固定版全面禁用自更新仍未知。
- Copilot / Grok 变量及更新开关依据当前官方文档；Cline 依据 main 自报同版本；Vibe 更新设置依据新版本源码，均不冒充固定包运行验证。

## 许可与参考

许可原文及元数据见 THIRD_PARTY_NOTICES.md；Amp 是社区适配器，Grok npm 引导包 Apache-2.0 不代表原生运行程序同许可。工具按需下载，不随 App 再分发。

只读参考 [Orca 固定源码](https://github.com/stablyai/orca/blob/9f32c6d06dd692824b888a1eb6b089cee4fb00b7/src/main/acp/launch/acp-launch-registry.ts)，该版本只列六个配置，不能证明本批十五家已支持或已验证。未复制实现。

实际检查见 native-acp-agents-impl.md §11；真实安装、账号、模型、系统终端、钥匙串隔离和 Windows/Linux 执行均未验证。
