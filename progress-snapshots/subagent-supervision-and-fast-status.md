# 子任务监督、主动推进与 Fast 消息显示修复

2026-10-18 · `subagent-supervisor-recovery` 基 `5850c11`。公开 Latest 仍 beta.31；本轮源码/证据供后续整合，未推送、tag、打包或自动安装。群任务看板另树末审，不把本轮结果当其验收。

## 修复

1. `subagentNotifyText()` 原来给 done/failed/timeout/lost/stalled 也附“停止后只汇报状态，不继续原任务”，混淆执行事件与用户叫停。新增 `subagent-supervision.ts`，notify/task_wait 共用：完成先核验；失败/超时核对断点、产物和副作用后，在清楚的原授权内优先原 id 续跑或父会话接手；停滞不重复派发；真正停止不自动复活。runtime 系统规则、resume 工具说明同步。不改 Pi SDK、不扩大超时/重试，不把规则文本冒充真实模型质量保证。
2. 主动巡检采用专属会话、可信相关对话 id、统一行动与授权边界、持久队列及真实 runtime 接线；真正产生并读取核验清单文件，结果留在原会话。停止/删除/重启/迟到确认/每日执行上限等边界见 [完整记录](proactive-recovery.md)。
3. `runtime.abort({scope:'conversation'})` 与 `stopConversationSubagents()` 提供单会话收拢，排队派发暂停采用计数避免嵌套停止互相解除保护；供群任务精确暂停使用，保留原无参 abort 的既有全助理子代理收拢语义。
4. Fast 状态先判该请求是否真的开启/尝试；关闭且只有普通 default/auto/flex 回显不常驻。保留原 meta，实际历史 Fast 请求不因当前关灯消失；外部 priority/明确快档回显保留中性来源及不确定性。只改显示，不改 payload、模型、思考强度或400/403重试，不据 default 推断计费。

## 实跑

Node24.19.0，临时根/内存凭据/Mock或loopback，无生产数据与付费请求。

- 原监督/resume/wait75项全部通过：`logs/subagent-supervision-tests.log`。
- 新增队列/停止/归属/竞态等后，proactive + subagents/resume + waits + Fast 协议合组：**118/118通过**：`logs/autonomy-fast-server-final.log`，含未装载 runtime 释放回归。
- Fast/两层目录/思考滑块纯前端55/55：`logs/autonomy-fast-front-final.log`。单独 Fast10/10：`logs/fast-status-pure.log`。
- 两端类型检查：`logs/supervision-proactive-typecheck-final.log`；Web build：`logs/fast-message-build.log`。
- `e2e/fast-message-status-ui.mjs` 真链 PASS：loopback OpenAI SSE → Pi → 持久 Fast meta → 真实构建 UI。关灯不送 tier/default不显示，刷新仍隐藏；开灯只加 priority、思考不变且保留不确定说明；再关不注入、不擦旧请求事实；390正文边界可见，正好3次请求、无额外重试。`logs/fast-message-status-ui.log`。图片在 `evidence/fast-message-status/`，主会话已打开桌面/390两张核验。

## 限制

未跑全量测试，未做真实云模型规划/核验质量、真实 Fast 加速或费用、安装 App/WebKit/Safari/物理手机/跨平台完整任务验收。供应商连接超时根因仍未知。群看板必须另验运行中暂停、跨群隔离及最终整合，不因有接口/通知或程序 exit0 就算目标完成。
