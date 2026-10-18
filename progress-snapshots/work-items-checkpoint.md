# 长期任务与群任务看板：阶段检查点（2026-10-18）

工作树 `task-responsibility-integration`，分支同名，基 `5850c11`。这是原实现阶段快照；随后主会话审查发现取消接线、跨群权限、执行关联及重试边界缺口，修复见 [边界记录](work-items-boundary-fix.md)。原run13仅证明其当时成功链，不是安全边界验收。未 push/tag/release、未安装或重启生产 App；公开版仍beta.31。

## 已完成的真实链路

1. 群里说清需求（目标/范围/完成标准）→ 管理者 `work_create` 记录原任务并派给成员。
2. 成员在自己的群里回合真写 `out.txt` → `deliver_file` 发到群 → `work_submit` 提交；结果卡进群。
3. 管理者收到一次 followup：`work_list` → `read` 实际交付文件 → `work_verify pass` 写检查结论；任务才变已完成。
4. 用户在看板「在群里说」指出具体问题 → 服务端写入可信 `workItemId` → 下一轮管理者拿到任务上下文：
   - 已完成任务先 `work_update reopen`，再 `edit` 新要求，再 `continue` 同一任务；
   - 待核验任务先 `work_verify return`，退回本身就是改进要求，自动安排原任务下一次执行（有上限）。
5. 第二次执行仍由原成员真写/交付/提交，管理者再 `read` 核验；旧修订执行保留为历史并标 stale，不覆盖新责任。
6. 失败 / 受阻 / 暂停 / 取消 / 核验结论都有一次群内系统提示；成员真实交付和核验结论仍在原群可读。
7. 看板是同一份任务数据的视图：桌面按状态分组，已完成/已取消默认折叠；390px 纵向列表 + 状态筛选；详情含需求、完成标准、最近进度、验收结论、执行历史、可用动作和「在群里说」。
8. 操作失败可见并保留草稿；刷新后任务仍在；没有不断轮询（打开/动作/bus `work.items` 时刷新）。

## 代码与契约（本树）

- 新增 `packages/server/src/work-items.ts`：独立业务表 `work_items` / `work_item_runs` / `work_item_events`；状态 `pending/active/blocked/review/done/paused/cancelled`；修订号 + 执行代次；actor 由会话闭包 / 用户 HTTP 绑定；晚结果只追加历史。
- 执行关联：`room_turns.work_item_id/work_run_id`；`work_create` 直接派发与 `room_assign.workItemId` 排队认领两条路径；不新建 runner，不改 Pi SDK / node_modules。
- 自动推进：`verify return` 在负责人/群未暂停/未到自动重试上限（3）时直接安排同一任务下一执行；用户暂停/取消/群本轮暂停/权限失败都尊重；不做轮询。
- 工具：`work_create` / `work_submit` / `work_verify` / `work_list` / `work_update`；加入 `runtime.ts` 内建 trusted 工具列表（不产生审批卡）。
- HTTP：`GET/POST /api/rooms/:rid/work-items`、`GET/PATCH /api/work-items/:id`、`POST /api/work-items/:id/{start,continue,pause,cancel,verify}`、`POST /api/work-items/:id/feedback`（服务端写可信任务关联）。
- UI：`apps/web/src/components/WorkItems.tsx`；群顶部「任务」入口，原「子代理」入口改名「执行」；`ChatMessages` 渲染任务结果卡；`store.workVersion` 由 bus `work.items` 更新。
- Mock：`packages/server/src/pi-adapter/mock-provider.ts` 增加长期任务脚本；真实写文件、真实 `read` 核验，不用字符串自报冒充 done。

## 实际跑过（Node v24.19.0，确数）

| 检查 | 命令 / 入口 | 结果 | 日志 |
|---|---|---|---|
| 长期任务定向单测 | `node --import tsx --import ./packages/server/test/setup.ts --test --test-concurrency=1 packages/server/test/work-items.test.ts` | **13/13 pass，0 fail**（含 5 个缺口/失败/自动重试边界） | `logs/work-unit4.log` |
| 群聊原有路由 + 幂等 | 同上，`rooms.test.ts` + `message-replies-queue-dedup.test.ts` | **23/23 pass，0 fail** | `logs/work-unit5.log` |
| 两端类型 | `npm run typecheck`（server tsc + web tsc） | **exit 0**（最后一次代码改动后复跑） | `logs/work-typecheck-final.log` |
| Web 构建 | `npm run build -w @pi-assistant/web` | 通过（最终 CSS 修复后、run13 使用的构建） | 控制台输出；`apps/web/dist` |
| 真实 Mock UI e2e | `e2e/work-items-ui.mjs`（临时服务 + PiMock + 真实构建 + Chrome） | **run13 exit 0 / PASS** | `logs/work-e2e-run13.log` |

run13 覆盖：首次任务→成员真写 `out.txt`→发群→提交→管理者 `work_list` + `read` 真实文件→核验；看板「在群里说」→同一任务重开/更新要求/第二次执行→再核验；群内成员交付与核验/重开可见且每次交付只有一张结果卡；失败可见+草稿保留；390px 页面/看板/详情不横向溢出；刷新持久化；页面无 pageerror。

390 的已知设计预期：状态筛选条在 375–390 宽度内部横向滚动；长进度在行内最多显示两行（`-webkit-line-clamp:2`），完整内容在详情可见。日志里 `WIDE` 显示的 `pa-work-filters` / `pa-work-progress` 的 `scrollWidth` 大于视口属于这两个局部容器，不是页面或看板横向溢出（e2e 断言 `documentElement.scrollWidth` 与 `work-board.scrollWidth` 均 ≤ 390）。

截图 `docs/screenshots/work-items/01-detail-done.png`、`02-detail-second-run.png`、`03-error-draft.png`、`04-board-390.png`、`05-detail-390.png`；已用 `look_at_image` 逐张确认真实界面、任务名/负责人/状态/需求/完成标准/验收结论可见，390 文字换行正常。

## 已修掉的失败（保留记录）

- 单测 `active !== pending`（work-items.test.ts 旧 line 134）：创建时缺完成标准仍标进行中 → 现在缺需求/标准只记 pending，开始/继续拒绝笼统默认。
- 单测失败通知 `2 !== 1`（旧 line 152）：断言按整群统计，其他任务的自动重试失败通知也被算入 → 改为按本任务标题断言；代码行为正确。
- e2e run12 `work-item-row` 计数为 0（e2e line 209）：打开面板后异步列表尚未返回 → 改为先等第一行再计数。
- e2e run9 390 横向溢出 579px：`.pa-work-row-main` flex 子项 `min-width:auto` 撑开 → 补 `min-width:0 / max-width:100% / word-break`，run13 通过。
- Mock 曾重复 `work_create` / 重复 `work_verify`：followup 文案变更后 `isFollowup` 未同步、复用旧 `work_list` 结果 → 改为按当前步 `last.toolName` 推进，核验后重新取列表。

**此阶段“无已知问题”的原判断已被主会话边界审查覆盖。** run13之后发现并修复多项安全缺口；原13项单测也不证明运行中取消或跨群子代理隔离。主会话接手后20项工作任务回归通过，普通@/真实执行上下文、同管理者跨群、内存队列实际撤回、自动continue与room_assign不能绕max3均有针对性检查；运行中scope、最终前端与合组验收另记，不把旧UI通过沿用成新代码通过。

## 未验 / 风险

- 真实云模型是否稳定按 prompt 走完自然语言纠正未验；Mock 只证明链路与工具接线，不证明模型理解隐含目标。
- 失败后管理员回调：代码把 assign 失败也设为 `batchRan` 并触发一次 followup，但本轮未再跑真实失败 Mock e2e（仅单测参数与代码路径），需主会话定点复核。
- 自动重试上限 3 是代码常量；真实长期运行的成本、并发资源锁未测（仍沿用群串行调度，MAX_CONCURRENT=3 只是数量上限）。
- 真实 390 设备、其他主题、真机 App 未验；截图只覆盖内置暗色主题与 Chrome headless。
- 未发布；看板与 API 仍可能按主会话 review 调整。

## 清理

- e2e 脚本有 `finally` 收尾：关闭 browser、停止本次服务进程组、删除本次临时目录。
- 检查时没有本树残留 `launch-memory.ts` / e2e server 监听端口；`127.0.0.1:8787` 等是主会话/生产开发服务，未动。
- `/tmp/pia-work-items-UOOg3C` 是之前超时运行的证据目录，按主会话要求保留，未删除。
- 日志：`logs/work-e2e-run13.log`（最终通过的 e2e）、`logs/work-unit4.log`（13/13）、`logs/work-unit5.log`（23/23）；更早失败日志一并保留。

## 下一步（建议）

1. 主会话 review `work-items.ts` 状态机/权限与 `rooms/index.ts` 的自动派发边界。
2. 定点跑一次“成员执行失败后管理者 followup”真实 Mock 流程，确认只通知一次、不无限回环。
3. 需要时可再跑一次 390 / 明暗主题 / 真实模型的 UI 验收；在此之前不要宣称已发布或已全面验证。
