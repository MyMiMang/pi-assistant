# 测试隔离安全收口 + session-fork 未明失败定位（beta.25 候选，未发布）

- 日期：2026-10-16
- 候选树：`release-candidate-validation`
- 基线 HEAD：`002ed1f`（候选整合收口）；本任务提交见下
- 状态：**未 push / 未 tag / 未打包**；beta.24 仍是公开 Latest。

## 背景：新 e2e 会碰 OS 钥匙串（违背强测试隔离底线）

主核发现本轮新增的 4 个 e2e 直接 `spawn packages/server/src/main.ts`，只设 `PIA_DATA_DIR`：

- `e2e/session-fork-ui.mjs`（L52）
- `e2e/session-fork-http.mjs`
- `e2e/voice-source-live.mjs`（L33）
- `e2e/send-shortcut-ui.mjs`（L29）

它们**继承真实 `PIA_WORKSPACE`**、且未注入内存 `CredentialStore`，服务端会构造走 `security` / OS 钥匙串的安全凭据后端——测试可能弹系统钥匙串、读写真实配置。

## 修法

1. **`packages/server/test/launch-memory.ts` 最前面加 guard**（在任何动态 import（config / models / 内存凭据）之前执行）：
   - `PIA_DATA_DIR` 必须是可信临时目录（`os.tmpdir()`、`/tmp`、`/private/tmp`，用 `path.relative` 精确判断，避免 `/tmpx` 误判；并对 `/tmp → /private/tmp` 符号链接做 `realpath`）；缺失 / 不可信 → 改用新的 `mkdtempSync` 临时目录，**绝不沿用用户真实数据目录**。
   - `PIA_WORKSPACE` 必须落在该临时数据目录内，否则**强制覆盖为 `<DATA>/workspace`**；缺省也补成 `<DATA>/workspace`。绝不写用户真实工作区。
   - guard **不 import `./setup.ts`**（否则会把 `PIA_DATA_DIR` 改成 setup 自己的临时目录，调用方按 `DATA` 读 DB 会错乱）；调用方指定的合法临时位置保持不变。
2. **`e2e/fixtures/safe-memory-server.mjs`（新，小 fixture，不造框架）**：`createSecurityProbe(dir)` 在 PATH 前缀放一个 owned by 临时目录的假 `security`（命中记一行，不触真实 `/usr/bin/security`）；`spawnMemoryServer({repoRoot,dataDir,port,probe,env})` 固定走 `test/launch-memory.ts` 并写 `PIA_TEST_STARTUP_FILE`；`startupEvidence()` 读回 `{storeCalls, securityCalls}`。
3. **4 个 e2e 改走该入口**：`PIA_WORKSPACE=join(DATA,'workspace')`、注入内存凭据，并断言 `storeCalls > 0` 且 `security 调用 === 0`。
4. **`e2e/launch-memory-safety.mjs`（新）**：故意继承「生产样」毒值 `PIA_WORKSPACE`（`tmp/fake-production-workspace-<pid>` sentinel，**不使用真实用户路径**），断言入口覆盖为 `<DATA>/workspace`、sentinel 目录保持为空，且 `storeCalls>0` / `security 0`。

## session-fork-ui「3/5」的真正原因（作废旧「基线」说法）

- 旧记法「候选树与合入前 `composer-send-shortcut` 树都 3/5，非本轮引入」**作废**：那是用**不安全的 launcher** 测出来的现象。
- 真正原因：旧 e2e 继承真实 `PIA_WORKSPACE` 且未注入内存凭据，第 2 条消息发送时服务端仍走安全凭据后端（可能被钥匙串 / 真实工作区拖住），Mock 回复与 Pi settle 迟到 → 「第 2 条消息发送后等输入框清空」超时。并非 Pi 分支逻辑或 Enter 发送的 UI bug。
- 修后 `e2e/session-fork-ui.mjs` 稳定 **6/6**（连跑 3 次）。为不再按 UI 计数猜抖动，用例新增**服务端证据断言**：服务端确实收到两条 user 消息（`你好第一轮` / `第二轮问题`）、Mock 有两条 `assistant.done`、实际 `POST /api/agents/*/messages ≥ 2`。
- 未用 `a80b2cb` 独立 worktree 对照：修后已稳定通过，不需要伪基线；且**禁止**借候选 dist 或旧不安全 launcher 复现（会触钥匙串）。

## 本任务实跑（Node 24.19.0，全 Mock + 临时 `PIA_DATA_DIR`/`PIA_WORKSPACE` + 内存凭据）

| 用例 | 结果 |
|---|---|
| `e2e/launch-memory-safety.mjs` | 全过：`storeCalls>0`、`security=0`、sentinel 空、有覆盖提示 |
| `e2e/session-fork-ui.mjs` | **6/6**（连跑 3 次稳定；含服务端 POST / done 证据） |
| `e2e/session-fork-http.mjs` | **8/8** + 安全启动证据 |
| `e2e/send-shortcut-ui.mjs` | 全过 + 安全启动证据（截图 `evidence/send-shortcut/`） |
| `e2e/voice-source-live.mjs` | 全过 + 安全启动证据（截图 `evidence/voice-source-live/`） |
| server `tsc --noEmit` | exit 0 |
| web `tsc --noEmit` / `vite build` | exit 0 / 通过 |

**0 钥匙串证据**：以上每次启动 `security` 探针计数均为 0，`PIA_TEST_STARTUP_FILE.storeCalls > 0`（走内存后端）。

## 同风险但本轮不改（仅登记，遵循「不做全 repo 生产 launcher 大换」）

以下 23 个文件仍直接 spawn 生产 `src/main.ts`（仅设 `PIA_DATA_DIR`，未注入内存凭据、未固定 `PIA_WORKSPACE`），属同一风险类，本轮不全部改造，留给后续统一处理：

`e2e/{composer-compact,custom-provider-delete,fast-computer-ui,image-viewer,model-capabilities,model-picker-favorites-ui,model-ui,pet,routines-ui,run,settings-desktop-resources,settings-subagent,skill-pick-ui,skills-scope,subagent-thinking-levels,subagents,task-ui,theme-ai-ui,voice-csp-audioworklet}.mjs`、`packages/server/test/{server-setup.test,subagent-fallback.smoke,subagent-restart.smoke,subagent-resume.smoke}.ts`。

（真实 CI 里启动 built main 的冒烟另有 temp data / runner 环境，不在此范围。）

## 未验 / 边界

- 不声称「全 repo 测试已全部不碰钥匙串」——只保证上述 4 个新 e2e + 新增 safety 用例。
- 真机 App / 真实云 / 真麦克风 / 真实 IME 均未跑；全量 `e2e/run.mjs`、全量 `npm test` 未跑。
- guard 只覆盖 `test/launch-memory.ts` 这一测试入口；生产 `src/main.ts` 行为未改。
- 假 `security` 只能拦截经 PATH 解析的调用；若某实现用绝对 `/usr/bin/security`，探针不覆盖（本任务按约定用 PATH 探针）。
