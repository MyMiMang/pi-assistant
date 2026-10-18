# 任务看板 / 责任执行：阶段 2 最后确认的后端边界（检查点，2026-10-18）

本文件保留子代理阶段2交回时的历史检查点。主会话随后修正旧turn精确关联、stop async state代次、真实run历史重试计数，并改连续4轮fixture为实际自动串链；最新25任务已纳入192项合组server通过，运行中取消/跨群隔离/失败改派/乱序分页UI通过。当前状态/失败记录与最终发布入口以[整合记录](beta32-long-tasks-integration.md)为准，不以此处旧24项和“未跑浏览器”覆盖后续核验。

交回时工作树 `task-responsibility-integration`，HEAD `373373c`，**该子代理未 commit / push / build / 浏览器 / 发布**。
本阶段只改 3 个我独占的文件 + 本检查点：
`packages/server/src/rooms/index.ts`、`packages/server/src/work-items.ts`、`packages/server/test/work-items.test.ts`、本文件。
未碰 `mock-provider.ts` / `http.ts` / 前端 / `runtime.ts` / `subagents.ts` / 其他 docs / e2e（主会话持有，工作树里它们的改动不是我的）。

## A. 群停止的作用域 + 持久停止事实（rooms.stop）

改动（`packages/server/src/rooms/index.ts`）：
- 不再 `stopAgentSubagents(memberId)`（那会停掉同一个助理在私聊 / 别群的全部子代理）。现在按成员只停**本群会话**：
  `stopConversationSubagents(m.agent_id, m.conversation_id)`，跳过还没建群内会话的成员。
- 当前这一轮用 `runtime(agentId, conversationId).abort({ scope: "conversation" })`（`abortConversationTurn`，与 `cancelWorkTurn` 共用），不再无参数 `abort()`（那会落到 agent scope 全停）。
- **先同步失效、再异步取消**：置 `s.stopped` / 清 `replan` → `cancelQueue` → 把数据库里本群所有 `queued|running` 的 `room_turns` 收成 `cancelled` → `onRoomTurnsClosed(..., "cancelled")`（关联 run 落 cancelled）→ 写持久停止事实 → 本群任务标 paused，之后才 `await` 停子代理 / 中止当前请求。异步窗口里自动派活已被挡。
- 持久停止事实：`rooms.paused = { pending: [], reason: "群聊已停止", stopped: true }`（复用现有 `paused`，没有新增用户开关 / 列）。`states.delete` 之后仍有效，重启后也有效。
- `enqueueWorkTurn`：`stopped` 的 pause **自动派活一律拒绝**（自动重试 / room_assign 关联）；只有 `explicit`（用户 HTTP start/continue）才恢复，并清掉这条停止事实；本轮上限暂停（`paused` 无 `stopped`）行为不变。
- 停止前正在负责（`active|blocked`）的任务 → 新增 `pauseRoomWorkOnStop(roomId)`（`work-items.ts`）标 `paused`、推进修订、写事件 `room.stopped`。所以停止后一条无关新话题 / 管理者顺手 continue 都不会把它们复活；看板的暂停态仍要用户明确继续。
- 群停止时不再给 `cancelQueue` 之外留“正在跑但已停止”的假执行：`openTurns` 覆盖内存队列 + DB 残留（重启留下的 queued/running）。

## B. 继续（cap 暂停 / 用户停止 / 重启）不重放已开始的执行

改动：
- 到上限暂停时，`pending` 不再丢任务绑定：现在保留 `turnId / workItemId / workRunId / directed`（`rooms/index.ts` 的 cap 分支）；`bootstrapRooms`（重启）的 pending 同样从 `room_turns` 带上 `work_item_id / work_run_id / id`。
- 新增集中函数 `planPendingWorkTurn({ roomId, workItemId, workRunId, turnId? })`（`work-items.ts`，复用现有 `createRun`，没有第二个 runner / 额外按钮）：
  - `rebind`：run / turn 都**没有 started_at**（`queued|cancelled|interrupted` 且确认没开始）、任务仍 `active|blocked`、负责人 / 修订 / 群都对得上、且没有别的 live run → 给**同一任务、同一修订**新建一次执行（`createRun`），不额外计自动重试（原来那次已登记、只是没开始）。
  - `manager_check`：`started_at` 有值或 run 已经 `running|done|error` → 不重放旧命令、不新建执行，交管理者一个 `resume` 回合检查进度。
  - `skip`：任务 `paused|review|done|cancelled`、负责人变了 / 不在群里、修订已更新、已有新执行 → 不自动复活，并在群里留一条 `kind:"work-not-resumed"` 的说明。
- `continueRoom` 仍**同步 API**（DB + `enqueue` 同步，`void pump()`），`http.ts` 不用改；普通非任务 pending 回合照旧原样重排；没有 pending 时仍请管理者 `resume`。
- 用户明确 Continue 是新一轮授权，但不绕 `MAX_AUTO_RETRIES`（重排不新增计数，也不清计数）。

## C. 连续 4 轮退回的定向测试（不再手工写 auto_retries=3）

`packages/server/test/work-items.test.ts` 新增 4 条定向测试（真实 SQLite 行 + 真实服务函数，离线模式不连模型 / 不付费）：

1. `群停止：只停本群会话的子代理…`：真实 `rooms.stop` + 同一助理三处子代理行（本群会话 / 别群会话 / 私聊），断言只有本群会话 `stopped`；持久 `paused.stopped` 存在、内存队列为空；停止前的任务 `paused`、其 run `cancelled`；自动 `enqueueWorkTurn` 抛「已停止」且不入队；用户 `explicit` 派活可用且清掉停止事实，其它任务仍 `paused`。
2. `群继续：只重建确认没开始的排队执行…`：撤回的排队回合（run/turn 都无 `started_at`）→ `continueRoom` 后新 `room_turns` 行带新 `work_run_id`，该 run 已被真实 `attachTurnToWork` 认领成 `running`（不是只看 DB status），旧 run 仍 `cancelled`，只新增 1 次执行。
3. `群继续：已经开始的旧执行交管理者 resume…`：`started_at` 已存在 → 不新建 run、不重放 worker 回合，`wm` 收到 `reason=resume` 回合；已取消任务留在 pending 也不复活，群里说明原因。
4. `连续退回 4 轮…`：循环用真实 `queueAssignmentForWorkItem`（内部 `createRun`）+ `attachTurnToWork` + `submitWorkItem` + `verifyWorkItem(return)` + `editWorkItem`（改派推进修订，不清计数）：计数 `0→1→2→3`，第 4 次 `blocked`（blocker 含「自动重试已达上限」）且 run 数不增；随后管理者 `continueWorkItem`、`queueAssignmentForWorkItem` 都被上限拒绝且不新建；`pauseWorkItem` 后管理者 continue 仍被拒；`cancelWorkItem` 后 `queueAssignmentForWorkItem` 报「不能直接派活」，run 数不变。

## 实际跑过（Node v24.19.0，命令预载 `test/setup.ts`，临时数据目录，`PIA_OFFLINE=1`，没有真实模型 / 凭据）

| 检查 | 命令 | 结果 | 日志 |
|---|---|---|---|
| 长期任务定向单测 | `node --import tsx --import ./packages/server/test/setup.ts --test --test-concurrency=1 packages/server/test/work-items.test.ts` | **24/24 pass，0 fail** | `logs/work-final-unit.log` |
| 原群路由 + 幂等回归 | 同上，`rooms.test.ts` + `message-replies-queue-dedup.test.ts` | **23/23 pass，0 fail** | `logs/work-final-rooms.log` |
| 服务端类型 | `npx tsc --noEmit -p packages/server` | exit 0 | `logs/work-final-typecheck.log` |

说明：`verifyWorkItem` 的自动重试会经现有 `dispatchRun → enqueueWorkTurn → pump` 真的走到 `runtime().turn`；本树没有配置模型，`ensure()` 直接返回「没有可用的模型」，不联网、不调用真模型（第 4 条测试里每次自动执行后 `await 25ms` 等它收尾，属于离线 test driver，不是付费调用）。

## 未验 / 交给主会话

- **运行中的真实中止**（pump 正在 `await runtime().turn` 时按停止 / 暂停）只做了 DB + 内存队列层断言；`abort({scope:"conversation"})` 是否只中止本群对话、不影响同一助理私聊 / 别群的真实子代理，需要主会话的真实 PiMock HTTP/UI 场景（A 任务 pause + B 群同 agent 子代理）复核。
- 群停止后 UI 的 `paused.reason`（「群聊已停止」）展示、`room-continue` 卡片按钮行为未在浏览器验证（前端不归我）。
- `continueRoom` 的 rebind 在真实群里会让 pump 立刻跑这一轮；本轮测试用离线「没有可用的模型」收尾，没有验证真实模型成功回合里 `work_submit` 落库（主会话 e2e 覆盖）。
- 未跑全量 `npm test`、web typecheck、build、e2e、浏览器；未 commit / push / 发布。
- 失败 callback / 乱序 / 分页 UI 属主会话范围，本阶段未碰。
