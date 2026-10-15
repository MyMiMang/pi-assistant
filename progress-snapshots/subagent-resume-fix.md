# subagent-resume-fix（断网等失败：在原子代理原任务会话恢复，不新开）

分支 `subagent-resume-fix`，基于 `next-release-integration` 提交 `661550f`（已合 Jev）。唯一新独立 tree，未碰主集成 tree。

## 已落地并验证（本地 commit 见 git log）

### 核心：原 id 断点续跑（不新开子代理）
- `packages/server/src/subagent-resume.ts`：失败分类纯函数 `classifyResume` / `shouldAutoRetry` / `transportBackoffMs`。
- `subagents.ts`：新增 `attempt` / `retry_at` 列；`resumeSubagent(id)` 用**原子代理 id** 续跑（复用落库 Pi session、原任务、历史与用量），满额照旧进 FIFO 排队不超并发；原子占用，重复调用只生效一次；`resume=2` 走失败续跑提示（先核验、不重做、不重复副作用）。
- `subagents.ts`：`withResumeInfo` 安全摘要（`canResume` / `resumeReason` / `retryable` / `waitingRetry` / `attempt`），不给提示词与凭据。
- `runtime.ts` 驱动：连接类错误在同一会话**有界退避重试**（`maxAttempts=3`，指数 + 抖动，封顶 8s）；**只对连接类**（`cls==="transport"`）生效，429/5xx 仍走 Pi 自身请求重试 + 池内 fallback，不重复等一个 Pi 重试周期；退避期间只等时钟、不发模型请求（无忙轮询），可被停止打断（`setSubagentRetryAt` 只更新卡片）。
- 接口 `POST /api/subagents/:id/resume`；工具 `subagent_resume`，并改 `subagent_list` 描述引导主模型优先续跑而非重派。
- 测试用公开 `memoryCredentialStore()` 注入 `initModels(credentials)`，不 new 默认安全后端、不碰钥匙串。
- 回归：`test/subagent-resume.test.ts`（6）、`test/subagents.test.ts`（36，含新 5 个续跑用例）全绿；`npm run typecheck` 通过。

## 真实已证可恢复矩阵（有测试支撑）
| 情形 | 自动续跑 | 手动原 id 续跑 | 依据 |
|---|---|---|---|
| 断网 / ECONNRESET / ECONNREFUSED / DNS 临时 / 超时 | ✅ 有界退避 | ✅ | classifyResume→transport；shouldAutoRetry 上限 3 |
| 429 retry-after / 5xx / provider 临时不可用 | ✅（Pi 请求重试 + 池内 fallback，不在 app 层重复） | ✅ | classifyResume→transient；fallback 冒烟绿 |
| 服务重启中断 | ✅ 重新入队续跑 | ✅ | recoverSubagents（既有） |
| 模型上下文超限 / 会话损坏 | ❌ | ✅ 修好后 | context / session |
| 永久 401·403 / 配置错 / 余额不足 / 模型被删 | ❌ | ✅ 修好后 | config |
| 用户 cancel/stop / 权限拒绝 | ❌（不自动恢复） | ✅ 显式 | blocked |
| 未知原因 | ❌（不做全量白名单误重试） | ✅ 核验后 | unknown |

## 未做 / 后续
- 冒烟 `subagent-resume.smoke.ts` 已过：真实起服务 + mock 断网一次 → 同 id、同一 session 续跑完成，无新 spawn。
- UI：失败/超时任务卡「继续」按钮（调 `/resume`）、等待重试/attempt 展示；`Tasks.tsx` 摘要。
- e2e：subagents.mjs 增断网续跑断言。
- 未动：主集成 tree、secrets.ts / SDK 凭据实现、真实配置、security / reset。
