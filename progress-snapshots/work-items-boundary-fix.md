# 任务看板候选：边界修复（阶段 1 检查点，2026-10-18）

工作树 `task-responsibility-integration`，**未 commit / push / build / 跑浏览器 / 发布**。只改了本任务独占的 4 个文件 + 本文件：
`packages/server/src/work-items.ts`、`packages/server/src/rooms/index.ts`、`packages/server/src/rooms/logic.ts`、`packages/server/test/work-items.test.ts`。
未碰 `runtime.ts` / `subagents.ts` / `http.ts` / 前端 / mock-provider / 其他 docs。

## 实际改动（按边界）

1. **取消作用域（DB + 内存一致）**
   - `cancelWorkRuns` 之前把 `run.work_item_id`（任务 id）当 roomId 传给 `cancelWorkTurn`，内存队列不动、DB 却被改 → 回合照跑。现在用可信 `item.room_id`，并按 `run.exec_id` / `room_turns.work_run_id + room_id` 两种精确关联找回合。
   - `cancelWorkTurn(roomId, turnId, abortCurrent)` 先用 DB 校验该回合确实属于 roomId，不属于就返回 `false` 且不改任何东西；运行中且 `abortCurrent` 时走 `runtime(...).abort({scope:"conversation"})`（当前树 `abort()` 无参数，用可选参数调用，主会话合入 conversation scope 后自动生效），不复刻 `stopConversationSubagents`。
   - 运行中但 `abortCurrent:false`（改派 / 改要求）：不把 `room_turns` 假装取消，让这一轮自然结束，业务 run 已落 `cancelled`，结果只能进历史。
   - 新增 `onRoomTurnsClosed(turnIds, "cancelled"|"interrupted")`：`cancelQueue` / `cancelQueuedFor` / `bootstrapRooms` 撤回或中断回合时同步 work run，避免看板一直「排队中」、`continue` 被「已有执行」挡住。

2. **同一个管理者跨两个群的工具边界**
   - `WorkActor.agent` 增加可选 `roomId`；`workItemTools` 固定绑定当前群；`requireManagerOrUser` 先校验任务属于 actor 的群。HTTP 用户 actor 仍是全局 `{kind:"user"}`，不信请求体身份。

3. **执行绑定精确化**
   - `PlannedTurn` 增加可选 `workItemId/workRunId`，`s.assignments` / `planAfter` / `enqueue` 串通，派活时就把 `work_run_id` 写进 `room_turns`。
   - `attachTurnToWork` 删掉「按 agent 找最老无 exec_id 的 queued」宽松搜索，只认这一轮在 `room_turns` 里绑定的 run（含 scope / owner / revision / 状态），不符就把 run 落 cancelled 并返回 null。
   - `room_assign` 先校验长期任务再登记 assignments（失败不建 run、不派人）；同一位成员同一轮绑第二个长期任务明确拒绝（不再被 `planAfter` 按 agent 静默去重错绑），普通非任务派活去重行为不变。
   - `queueAssignmentForWorkItem` 补齐 start 同一条门：本群 / 负责人是可用成员 / 需求与完成标准齐 / 状态允许；不齐不建 run。
   - `submitWorkItem` 改为宿主上下文绑定：必须存在该成员本轮 `room_turns.status='running'` 且绑着本任务的 run，`runId` 只作一致性校验不接受自报授权；没有执行上下文时区分「这一轮不是任务执行」和「这次执行已被暂停/取消/改派」。

4. **自动重试上限**
   - `editWorkItem` 不再清 `auto_retries`；`startWorkItem` / `continueWorkItem` 只在 `actor.kind === "user"`（HTTP 用户明确授权）时清 0，管理者工具调用不清，不能换状态绕 `MAX_AUTO_RETRIES`。`verify pass` / `reopen` 仍按原语义重置。

5. **群暂停 / 停止挡自动派活**
   - `enqueueWorkTurn` 新增 `{explicit?:boolean}`：`rooms.paused` 或内存 state `stopped` 时自动派活直接拒绝（`createWorkItem` / 自动重试 / room_assign 都自动失败并落 `blocked`）；只有用户 HTTP start/continue 传 `explicit` 才允许在暂停时派这一轮，且不清群暂停。仍复用群原有串行队列与 caps，没有第二个 runner。

6. **失败后协调 / 失败状态**
   - `noteRoomTurnEnd` 执行 `error` 且当前修订仍 active → 任务明确 `blocked`（带 blocker），不再「没有执行却永远进行中」；`submit` / `continue` 仍允许。
   - 失败回合的 followup 走已有 `reason=assign → batchRan=true → planAfter`，没有加第二重回调（用纯逻辑断言覆盖，不重复通知）。

7. **列表分页（主会话补充要求）**
   - `listWorkItems` 支持可选 `beforeId`，`ORDER BY updated_at DESC, id DESC`；`before + beforeId` 用 `(updated_at < ? OR (updated_at = ? AND id < ?))`（同毫秒不漏不重），只给 `before` 保持旧「严格小于」；响应保留 `hasMore/nextBefore` 并新增 `nextBeforeId`（客户端用最后一条 id 作游标，无新 schema）。`http.ts` 传 `beforeId` 已在树里，这侧刚补上接收方。

## 实际跑过（Node v24.19.0，命令预载 test/setup.ts，临时根，无真实 DB/凭据/付费）

| 检查 | 命令 | 结果 | 日志 |
|---|---|---|---|
| 长期任务定向单测 | `node --import tsx --import ./packages/server/test/setup.ts --test --test-concurrency=1 packages/server/test/work-items.test.ts` | **20/20 pass，0 fail** | `logs/work-boundary-unit3.log` |
| 原群路由 + 幂等回归 | 同上，`rooms.test.ts` + `message-replies-queue-dedup.test.ts` | **23/23 pass，0 fail** | `logs/work-boundary-rooms2.log` |
| 服务端类型 | `npx tsc --noEmit -p packages/server` | exit 0 | `logs/work-boundary-typecheck.log` |

新增/重写的定向断言（都是先看真实源码再写）：取消排队执行会真的从内存队列撤回（不是只改 DB）；跨群管理者工具调用被拒且 B 群任务/事件/群提示/回合数不变（真 same-manager-cross-room，旧的 `void otherMgr` 空断言删掉）；普通 @ 没绑定 run 不能提交、自报 runId 不授权；任务 id 当 roomId / 别的群 roomId 调 `cancelWorkTurn` 不改任何回合；群暂停时自动派活被拒且只留一条 error 执行；失败 → `blocked`；`edit` 后计数不被清、第 4 次退回 `blocked` 且无新 run；同毫秒 `updated_at` 翻页不漏不重。

## 未验 / 交给主会话

- 内存队列撤回已在定向单测覆盖（占住串行泵后第二个回合确实在 `stateOf().queue` 里，撤回后立刻不在），但这是「真正 running + 暂停」之外的路径；运行中暂停的真实中止仍要看主会话 runtime 合入后的群回合复核。
- `runtime.abort({scope:"conversation"})` 在本树是可选参数调用（`abort()` 忽略参数 → 仍中止该会话 runtime）。等主会话合入新 scope 后需复跑一次「暂停运行中任务只停本群对话」。
- 失败回合的管理者 followup 只做了纯逻辑（`planAfter`）与状态断言，没跑真实失败 Mock 群回合（mock-provider 不归我改）。
- 前端 `WorkItems.tsx` 的 `beforeId` 使用、HTTP 路由、`webUI` 最终联调都未在这棵树里跑（主会话 owner）。
- 没跑 typecheck 的 web 部分、build、e2e、浏览器；没跑全量 `npm test`（按要求只跑受影响用例）。
