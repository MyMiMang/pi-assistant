# Pi SDK 1.2.0 → 1.3.0 升级（设计 + 验收）

- 状态：**独立分支 `deps/pi-1.3.0` 已实施并本地验证中**（基发布树 `release-candidate-validation` `decb8eb`）；**未合入候选 / 未 push / 未 tag / 未打包，未改动已公开发布的 beta.24**。
- 用户新授权：已完成只读审计后，用户已同意开展这次独立升级适配；本页取代审计报告中「本轮未授权」的旧口径。
- 约束：不改 Pi 本体 / 不 fork / 不改 `node_modules` 内上游文件 / 不 monkeypatch 私有接口；兼容逻辑只放自有 `pi-adapter` 与 `packages/ext-*`，只走公开 API；三个直连包**精确 pin**。
- 上游来源：npm `latest` = 1.3.0（publish `2026-10-15T19:13:30Z`），GitHub tag `v1.3.0` CHANGELOG 同一版本；三个包 `pi-coding-agent` / `pi-ai` / `pi-mcp` 同版。`main` 的 `[Unreleased]` 为空，不按 main 走。

## 1. 依赖变更

- `packages/server/package.json`：`@earendil-works/pi-coding-agent` / `pi-ai` / `pi-mcp` 由 `^1.2.0` 改为**精确 `1.3.0`**（对齐上游 1.3.0 起对内部 Pi 依赖的精确 pin，#10865；避免无 lock 的 fresh install 静默混入下一个 minor）。
- `scripts/pi-update.mjs`：`bump` 用 `npm install --save-exact`，以后升级都写精确版本；`testedWith` 仍只在 `finalize`（测试通过后）改写，bump 只写 `target`。
- `package-lock.json` 差异**逐条审阅**：只涉及 7 个 `@earendil-works/*` 条目（`pi-agent-core` / `pi-ai` / `pi-codemode` / `pi-coding-agent` / `pi-mcp` / `pi-telemetry` / `pi-tui` 1.2.0→1.3.0）+ `packages/server` 的 3 条 spec 变精确；integrity 与 npm registry 值一致；**无新增其它依赖、无密钥文件**。上游 1.3.0 起把内部 Pi 依赖从 `^1.x` 改成精确 `1.3.0`（锁文件可见）。
- `third-party.json` / `THIRD_PARTY_NOTICES.md` 由脚本同步到 1.3.0；`compat.json` 先为 `{ "testedWith": "1.2.0", "target": "1.3.0" }`，本轮定向 + 全量验证通过后已由 `node scripts/pi-update.mjs finalize` 提升为 `{ "testedWith": "1.3.0" }`（`check:pi` = `Pi 已安装 1.3.0 · 兼容基线 1.3.0 · npm 最新 1.3.0`）。`SessionManager.CURRENT_SESSION_VERSION` 仍为 3，会话 JSONL 无需迁移。

## 2. 公开 API 面差异（对已安装包实测 `.d.ts`）

| 包 | 变化 | 性质 |
|---|---|---|
| `pi-coding-agent` | 入口新增 `formatReadLineRange` | 只增 |
| | `core/agent-session.d.ts`：`usesDefaultTools` 语义变、`_restoreToolsFromTranscript(modifiers)` 加参数 | **行为变化（风险①，见下）** |
| | `core/model-resolver.d.ts`：内部重构（`parseModelPattern` / `ParsedModelResult` → `ModelReferenceRequest` / `ModelReferenceResult`）；**包入口导出的 `resolveCliModel` 等保留**，我们未引用内部符号 | 不影响 |
| | `settings-schema.d.ts`：新增可选 `sessionShareDestination`（默认 `auto`） | 只增可选（我们用 `SettingsManager.inMemory`，不做 `/share`） |
| `pi-ai` | 入口**移除** `assistant-message-frame.ts`（`AssistantMessageFrame` / `AssistantMessageFrameEncoder` / `reduceAssistantMessageFrames`） | 公开导出删除，但全仓 grep 无引用，`typecheck` 兜底 |
| | `types.d.ts`：`ToolCall` 新增可选 `argumentsError?` | 只增可选 |
| | `utils/json-parse.d.ts`：新增 `parseToolCallArguments()` | 只增 |
| | `providers/kimi-coding.d.ts`：`Provider<"anthropic-messages">` → `Provider<"openai-completions">` | **协议变更（风险③，见下）** |
| | `compat-schema.d.ts`：新增可选 `supportsMidConvoEffort` | 只增可选 |
| `pi-mcp` | `dist` 无差异 | 无变化 |

私有 import / 深链 0 个：仍只用三个包入口 + `pi-ai` 官方子路径导出（`compat` / `models` / `api/*`），由 `test/pi-sdk-boundary.test.ts` 守卫。

## 3. 风险①（最高）resume 恢复 active tools —— 已实测并适配

**官方行为（1.3.0 `#10785`）**：resume 会恢复会话转录里记录的 active tools（`toolsAdded`），并把 `--tools +name/-name` 叠加上去。我们生产三条路径都不传 `tools` → 默认 `["+grep","+find","+ls"]`（全是修饰符）→ `usesDefaultTools = true`，因此**会触发恢复**。`allowedToolNames` 对我们为 undefined，恢复只受 `excludeTools` 约束。

**真实 Pi 会话实测**（`packages/server/test/pi-1.3-tool-restore.test.ts`，faux provider + 本地 stdio fake MCP，临时目录 + 内存凭据）：

| 场景 | 实测结果 |
|---|---|
| resume 恢复 | `tool_search` 等转录里记录的工具会回来（1.3 新语义） |
| MCP server 已**移除** | 工具不再注册 → 恢复项被丢弃，不复活 ✅ |
| MCP exposure 改 **hidden** | 工具不注册 → 不复活 ✅ |
| MCP exposure direct→**deferred**（server 仍启用/仍注册） | 恢复为 active（**1.3 特性保留**；不是越权，副作用仍过 `ext-approval`） |
| 受限会话用**纯工具名列表**（如主题设计 `["theme_draft"]`）+ `inMemorySession` | `toolModifiers` undefined、`usesDefaultTools=false` → 不恢复，双保险 ✅ |
| 技能撤销 | 技能经 `skillsOverride`，**不是 tool**，恢复逻辑不涉及 → 不复活 ✅ |

**adapter 决策（不裁掉 1.3 特性，只用公开 API，不改 Pi 源码）**：第一版适配曾用公开 `setActiveToolsByName` 做「resume 时把非 direct 的 MCP 工具从 active 撤下」的 reconcile，但那会把「上一段会话里经 `tool_search` / `codemode` 激活的 deferred 工具」也一起清空——**等于把 1.3 的「会话内激活的工具跨重启保持」整个关掉**。因此不采用 blanket-drop，改为按**当前 eligibility**收敛：

- **direct / deferred / codemode**：服务器启用且指派给该助理时工具仍注册、仍 eligible → 恢复保留（1.3 特性完整保留）。
- **hidden**：Pi 自己的 `_applyToolLoadout` 已按 exposure 过滤，恢复也不会 active（实测②）。
- **已移除 / 停用 / 未指派**：不注册 → Pi 恢复时丢弃（实测③）。
- 轮到的具体表达式：Pi 只把「当前已注册且可激活」的工具恢复为 active，我们不再额外裁剪；受限会话仍可用**纯工具名列表**或 `excludeTools` 强制固定工具面（都是公开 API）。

**已接受 / 已知残余**：MCP 服务器从 `direct` 改成 `deferred` 后，对**同一段**被 resume 的会话不会追溯生效（其工具仍随转录恢复为 active，重新开一段会话才按新 exposure）；这是可见性 / token 回归，**不是越权**（副作用仍经 `ext-approval` 闸门）。需要严格固定工具面的会话用纯工具名列表或 `excludeTools`。

**为什么不用 `excludeTools` 当通用兜底**：实测（临时探针，已删）被 `excludeTools` 排除的工具连 `tool_search` 都搜不到（`No matching tools found.`），会把按需发现一起废掉。

## 4. 风险②③④ 实测

- **H4 codemode worker 上限**（`test/pi-1.3-codemode-limit.test.ts`）：worker 在**一个进程里跨会话共享、上限 2**（`#10748`）。真实 3 会话并发实测：前两个各占 1 个 worker（脚本各 ≈3s）正常完成，**第 3 个立刻**拿到可读错误 `Codemode worker limit reached (2 workers are still running or shutting down). Retry after they exit.`，会话不挂起、无自动重试队列。结论：多会话单进程下第 3 个 codemode 调用会**快速失败并可重试**，不是排队；上层可把它当「稍后重试」。取消后 worker 真正退出（受 SDK 计数控制）——不绕 SDK 上限另开进程。
- **H3 Kimi 协议**（`test/pi-1.3-providers.test.ts`）：`kimi-coding` 的 4 个模型全部 `openai-completions`，**来自 Pi 目录 metadata**（我们经 `runtime.getProviders` 动态读取，不硬编码协议）。自定义服务写进 Pi `models.json` 的 `baseUrl` **原样保留**（含不带 `/v1` 的私有 relay），不因为 1.3 的新要求去给所有中转补 `/v1`。残留：用户若在**自己的** `models.json` 手写 `kimi-coding` 覆盖且不带 `/v1`，会被 1.3 拒绝——我们只在 `{dataDir}/models.json` 写自定义 service，正常不会命中；如命中需要手动补 `/v1`（不自动改用户私有配置）。
- **H5 工具参数坏 JSON**（`test/pi-1.3-tool-args.test.ts`）：带 `argumentsError` 的工具调用**校验失败且不执行残缺字段**，模型看到 `Invalid arguments for tool "write": Invalid JSON. Raw arguments: {...`，目标文件未被创建。嵌套 codemode 调用仍走 `ext-approval`、abort 后 `final_delete` 不执行 —— 由既有 `test/tool-discovery.test.ts` 13/13 覆盖。
- **H6 模型切换丢旧 thinking / 思考档位**：旧模型 thinking 不再当文本喂给新模型（上游 #10995），对我们原地切模型是正收益。档位仍全部来自 Pi 目录（`getSupportedThinkingLevels`，签名未变）：`test/thinking-levels.test.ts`、`test/subagent-thinking-options.test.ts` 在 1.3.0 下通过（`xhigh`/`max` union、不灵空补档位）。同一模型改档位是否保持 prompt cache（GPT-6）由 Pi/`pi-ai` 负责，我们自有层不额外加盐、不改缓存 ID。

## 5. 验收（本轮实际跑了什么）

Node 24.19.0（`/Users/dengdeng/.local/node-v24.19.0/bin/node`，未系统升级）；依赖装在 `deps-pi-1.3.0` 自有 `node_modules`（官方 `npm ci --ignore-scripts` + `pi-update` bump，独立 npm cache，无源码 patch）。

| 检查 | 结果 |
|---|---|
| `npm run typecheck`（server + apps/web） | exit 0 |
| 1.2 兼容面定向（`pi-compat` / `pi-events-union` / `pi-mcp-1.2` / `pi-1.2-boot-context` / `pi-1.2-custom-provider` / `pi-sdk-boundary`） | **19/19** |
| 受影响面（`tool-discovery` / `session-fork` / `pi-entry-mapping` / `theme-ai` / `context-skill-pick-http` / `model-registry` / `thinking-levels` / `subagent-thinking-options` / `skill-assignments` / `mcp` / `mcp-install` / `model-picks`） | **70/70** |
| 新增 1.3 回归（`pi-1.3-tool-restore` / `pi-1.3-codemode-limit` / `pi-1.3-providers` / `pi-1.3-tool-args`） | **14/14**（见上各条实测） |
| `npm run check:pi` | `Pi 已安装 1.3.0 · 兼容基线 1.2.0 · npm 最新 1.3.0`（提示待验证升级目标） |
| `npm run build -w apps/web` | `vite build` 通过（1255.88 kB 主包） |
| 全量 `npm test`（769 项） | **758 过 / 1 失败 / 10 跳过**；唯一失败 `shared-computer 合并脚本` 是 macOS bsdtar 不支持 `--skip-old-files` 的**既有基线**（发布树 `decb8eb` 上同样失败），**1.3.0 无新增失败** |

## 6. 未验（明确边界，不 claim）

- 未真机运行 1.3.0；未跑全量 `e2e/run.mjs`、桌宠 e2e；未真机安装包 / 自动更新。
- 未连真实云模型 / 真实 MCP（cua-driver、真实 http 服务）/ 真实自定义服务 Key（只用 loopback + 假 Key）。
- H6 的「切换模型后旧 thinking 不进 provider payload」未在 payload 层直接断言（属 `pi-ai` 内部；本轮只验证档位目录与既有测试无回归）。
- H4 的「取消后 worker 实际退出」官方描述针对 Bun，Node 下由 SDK 计数保证；本轮验证了上限与错误可读性，未测取消后的额度回收时长。
- 官方安全公告未取（GitHub API 限流）——**「未提到 CVE」不等于「无漏洞」**，升级不以「安全紧急」为由。
- 未 push / 未 tag / 未打包；`compat.json` 已 `finalize` 为 `{ "testedWith": "1.3.0" }`（定向 + 全量通过后提升，完整 e2e / 真机仍属未验边界）。
