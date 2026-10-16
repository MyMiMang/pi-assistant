# Pi SDK 1.3.0 集成验收（候选树 checkpoint）

自包含记录：本轮「1.3 升级最后整合验收」实际做了什么、跑了什么、结果、边界。写给接手人，不依赖别的文档。

## 0. 位置与提交

- Worktree：`release-candidate-validation`，分支 `release-candidate-validation`（**独占**）。
- 基线：`decb8eb`（beta.24 已公开发布后的文档提交）。公开发布 tag `v0.1.0-beta.24 = 747c744`，**本轮未移动**。
- HEAD（本记录时）：`0069d36`。提交链：
  - `dc93fe4` 升级 Pi SDK 1.3.0：`--no-ff` 合入 `deps/pi-1.3.0`（`decb8eb` 仍是祖先，可整条回滚）。
  - `3bc1094` 测试：Pi 1.3 模型切换后旧 thinking 不进新 provider payload（loopback HTTP 实证）。
  - `0069d36` 修复语音入口克制：idle 不再常驻状态行 /「去设置」+ 前端 fixture 断言。
- **未 push / 未 tag / 未打包 / 未做任何系统动作**；候选树 HEAD 不是发布点。

## 1. 依赖（合入内容，源自 `deps/pi-1.3.0`）

- `packages/server` 三个直连包 `^1.2.0` → **精确 `1.3.0`**（`pi-ai` / `pi-coding-agent` / `pi-mcp`）；`scripts/pi-update.mjs` 改用 `--save-exact`（对齐上游 #10865）。
- `package-lock.json` 只涉及 7 个 `@earendil-works/*`（`pi-agent-core` / `pi-ai` / `pi-codemode` / `pi-coding-agent` / `pi-mcp` / `pi-telemetry` / `pi-tui`）1.2.0→1.3.0 + `packages/server` 3 条 spec；`third-party.json` / `THIRD_PARTY_NOTICES.md` 同步；`compat.json` 已是 `{ "testedWith": "1.3.0" }`。
- **候选树自己的 `node_modules`** 用官方 `npm ci --ignore-scripts` 从 1.2.0 升到 1.3.0；与 `deps-pi-1.3.0` 逐文件摘要一致，无 symlink / APFS clone，未改其它 worktree 的 SDK 源码、未 fork / patch / monkeypatch。
- 不改 Pi 本体、不改 `node_modules` 源码；Node 24.19.0（`/Users/dengdeng/.local/node-v24.19.0/bin/node`），未系统升级。

## 2. 本轮新补的实证：H6 模型切换旧 thinking 不进新 provider payload

之前缺口：只说「档位目录无回归」，**没有 payload 层断言**。现补 `packages/server/test/pi-1.3-model-switch-thinking.test.ts`：

- 只用公开调用点：`createPiSession` + `applyModelSettings`（= 生产 `runtime.ts` 的原地切模型路径 `session.setModel`）+ 生产 helper `composeQuotedInput` / `formatQuotedContext` / `skillCommand` / `saveSkill`。
- 数据目录 / 工作区强制临时目录 + 内存凭据；new provider 用 **loopback OpenAI 兼容中转**（`e2e/mock-openai.mjs`）记录**真实 HTTP 请求体**（openai-completions 内部走 pi-ai `transformMessages`），不是 faux 的预变换 context、不从 UI 推测。
- 用例：faux 模型产出真实 `thinking` block → 原地切到 openai-completions 目标模型 → 引用历史 + 本次选用技能一起发第二轮。
- 结果（候选树实跑）：`含thinking=false 含旧正文=true 含技能=true 含引用=true`。断言：旧 thinking 标记**不在**任何消息里（1.2 的 bug shape 是它作为文本出现，本用例在旧版会失败）；普通用户文字 / 引用历史 / 技能正文**都在**；正对照——旧模型的**正文回复**仍在 payload（证明不是整条 assistant 消息被丢）。

## 3. 实跑清单（候选树 1.3.0）

| 检查 | 结果 |
|---|---|
| `npm run typecheck`（server + apps/web） | exit 0 |
| `npx tsx --test pi-1.3-*.test.ts pi-sdk-boundary.test.ts` | **14/14**（4 个既有 1.3 文件 12 项 + 新 payload 1 项 + 边界 1 项） |
| `npm run check:pi` | `Pi 已安装 1.3.0 · 兼容基线 1.3.0 · npm 最新 1.3.0` |
| `npm run build -w apps/web` | `vite build` 通过（1255.94 kB 主包） |
| `e2e/model-ui.mjs` / `model-services-ui.mjs` / `skill-pick-ui.mjs` | 全通过 |
| `e2e/session-fork-ui.mjs` / `e2e/theme-ai-ui.mjs` | 5/5 / 5/5 |
| `e2e/voice-input-ui.mjs` | **38/38**（含本次新断言） |
| `e2e/composer-compact.mjs` | 全通过 |

## 4. 本轮的第二个改动（自有 UI，与 Pi 升级无关）

用户反馈：升级后聊天栏多了一个常驻「去设置」。根因是我们自有的 `VoiceInput.tsx`：`showSettings = voice.supported && !voice.asrModel && !recording` → 没配 ASR 就**常驻** status 行 + 「去设置」。属我们自己的语音 UI 不当（非 Pi 上游）。

- 修法（不改功能、不加新入口）：idle 只保留紧贴发送键左侧的麦克风图标，未配置说明放按钮 `title`；**只有用户点了麦克风、hook 回 `asr_not_configured` 时**才短暂浮现短说明 + 「去设置」（`onClick` 打开设置 › 模型，保持路由，点击后清掉临时提示）；取消 / 切会话清临时提示；不自动开权限、不换云 API、不砍麦克风。
- 断言（`e2e/voice-input-ui.mjs` 加 getUserMedia 计数）：idle 无 `voice-status` / `voice-open-settings`；点未配置麦克风才出现，且 **0 getUserMedia / 0 转写**；已配录音原流程不受影响；390 / 矮窗发送键不位移、引用条不动。
- **边界**：此修复**不在 beta.24 里**（beta.24 是旧的常驻入口），属未发布候选。

## 5. 未验 / 边界（如实）

- 未真机运行 1.3.0、未真机安装包 / 自动更新；未跑全量 `e2e/run.mjs`（第 1 步「首次运行向导」仍等旧「设为默认模型」按钮，是**既有基线失败**，与本次无关，故只用各功能 standalone fixture）与桌宠 e2e。
- 未连真实云模型 / 真实 MCP / 真实自定义服务 Key（只用 loopback + 假 Key）。
- 未 push / 未 tag / 未 release。发布需用户确认后由用户/主决定（下一版预计只构建 Apple 芯片 macOS）。

## 6. 手接手约定

- **设置 IA 正在由另一位 owner 整体重排**（模型页 / 语音配置页 / 在线服务统一模型服务 / Laya 归电脑操作）；本树**不重复大改 Settings / ModelServices**，也不自行新增任意 UI 按钮。新设计接本候选 HEAD（`0069d36`）。
- **在设置重排验收前不 push / tag / release。**
