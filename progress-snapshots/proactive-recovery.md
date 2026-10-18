# 主动唤醒 → 在原对话实际推进（2026-10-18）

本轮基于 `5850c11`，未推送、打包或安装；公开 Latest 仍为 beta.31。以下覆盖子代理早期“runtime 待接线/日期 10-19”的记录。长期群任务在另一分支，不能拿本轮检查代替它的验收。

## 行为与边界

- 普通巡检、到点跟进和变化信号共用 `ADVANCE_RULES`：目标、范围、约束及完成标准清楚，且原授权仍有效，才在原对话实际推进、核验并交付，不反复问“要不要做”。缺关键信息先澄清；新对外承诺、支出、破坏性改动或权限变更先确认。网页/邮件/文件是线索，不是新授权。
- 独立 `主动巡检` 隐藏会话只复用同助理、正确标题且不在 `room_members` 的会话，不能误用群成员隐藏会话。普通用户快照排除隐藏、task、subagent 消息；只为本助理现存普通对话输出可信 `[conv:…]` 目标。
- `proactive_advance` 经公开 `nudge(text,{onlyIdle:true})` 送到相关对话，不伪装新用户消息，不赋予新的工具权限。相关对话核对其真实历史和当前授权；主机会校验归属、隐藏位、开关、去重、静音及队列/执行上限，但不能机械证明模型对自然语言授权的理解正确。

## 持久状态与停止

`proactive_advances` 保存 `queued/started/done/failed/cancelled` 和原因，复用原 runtime，不是新 runner。这里的 `done` 只表示一次执行轮结束，**不是业务目标已验收**。

- 提醒与推进独立去重，推进键含 conversation id。排队不写 delivered；每对话最多3条队列，每助理每天最多12次自发推进，初始化派发中的短暂空闲也不能并发插第二轮。
- send 开始前原子 claim；失败、队满、不可派发均留下可见原因。迟到确认不能把 cancelled/done 改回 started；快速 settle 能接着排队项，不留卡死。
- 只恢复真正没发出的 queued；started 后重启结果不明则 failed、不盲目重放。bootstrap 已接 `resumeAdvances(undefined,{dispatch:true})`。
- runtime abort 先同步取消推进和在飞回调；settled(aborted) 取消而非 drain。停止记录持久化到当前真实用户消息序号，重启或新的巡检线索不能复活已停事项；须有后续真实用户消息，并继续由原对话判断是否确为新的/恢复授权。
- 删除/释放没有装载 runtime 的会话也会清持久队列；单会话释放和群任务中止用 conversation scope，不能按 agent 把别群/私聊的子代理一起停掉。
- 低/中/高巡检调度、免打扰、工作日和通知上限保持原策略；**一旦已准入的推进不占通知条数**，另受上述执行上限。已有任务的 notify/task_wait 接手不依赖一般巡检开关。未新增 UI 开关，也没有无限自动重试。

## 验证与证据

可靠 Node `/Users/dengdeng/.local/node-v24.19.0/bin/node`；命令预载 `test/setup.ts`，测试首个静态 import 也是 setup，临时 DATA/WORKSPACE、内存凭据、Mock/loopback，不接生产 DB、真实凭据或付费模型。

- `logs/proactive-main-runtime-check.log`：runtime 接线后的原23项通过。
- `logs/autonomy-fast-server-final.log`：本轮 proactive + subagents/resume + task-waits + Fast 协议最终合组 **118/118通过**；含新增去重命名空间、通知预算分离、每日12次边界、在飞串行、快速结束、停止持久化和未装载 runtime 的释放测试。
- `test/proactive-advance.test.ts` 使用真实 Pi Mock 会话、真实扩展和 runtime：明确要求季度报告核验清单 → 巡检调用 advance → `write proactive-advance.md` → Node 实际读文件检查“数据核对、来源链接、结论检查” → 原会话汇报；重复不重做，真实 abort 清队列，其他对话不受影响。不是“要求 PDF 却给 Markdown”的假通过。
- `logs/supervision-proactive-typecheck-final.log`：两端类型检查；Fast loopback 三次请求与真实构建 UI 另见 `subagent-supervision-and-fast-status.md`。

## 未验

未做付费真实模型的授权理解、自主规划和产物质量评估；没有声称任何模型都会正确完成任意长期目标。没有本轮安装版 WebKit/Safari、物理手机或跨平台完整任务验收。未跑全量 npm test/e2e，未根治供应商连接超时。群任务看板、运行中精确取消与整合回归须在合入后独立验收。
