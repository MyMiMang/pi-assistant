# 0016 群任务卡住由管理者自己处理，办法用尽才向用户说明
- 日期：2026-10-20
- 状态：有效（取代 0006 里「仍解决不了就问用户、给明确选项」那部分）
- 决定：群任务反复退回、长时间没进展、反复卡在同一处时，跟单聊帮手一样由管理者自己判断、自己换方法或改派推进；大部分决定管理者按群目标分析，没问题就自主推进。阶梯三级：管理者自己处理 → 最后提醒（原样重做停用，必须改派 / 拆小 / 自己接手，每个任务一次）→ 已用尽办法（标受阻，管理者在群里向用户说清问题是什么、需要用户帮什么或哪个决定它无权拍板；系统写失败总结并推送作兜底）。只有需要用户才能给的东西（批准 / 授权、登录凭据、只有用户有的资源）或超出群目标、管理者无权拍板的决定才问用户。改派给不同成员时重做次数清 0，但最后提醒不再给第二次；改要求不清。
- 原因：用户定（选 A）。旧做法一卡住就把「换个方法 / 改派 / 暂停」三选一丢给用户，和单聊「只为用户才能给的东西找用户」不一致，也打扰用户。
- 不做什么：不设费用 / 令牌上限；不让管理者无限原样重做（最后提醒只一次，换人后再撞直接用尽）；群对话「只聊不干活」检测这次不改。
- 影响：packages/server/src/stuck.ts（Escalation.rung、nextRung）、work-items/watch.ts（escalate 三级、exhaust、askNeed）、actions.ts（retryLimitReached、核验退回、改派清计数）、exec.ts、tools.ts（work_ask_user 说明）、rooms/scheduler.ts（管理者 check 文案）、apps/web/src/components/WorkItemDetail.tsx；测试 work-items-ladder.test.ts、work-items-harness.ts；设计 design/group-collaboration.md。
