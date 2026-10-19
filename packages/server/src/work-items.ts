/**
 * 长期任务（任务责任）对外入口：实现拆在 work-items/ 下。
 *  store   表结构、行读取、权限门、看板列表 / 详情 / 管理者摘要
 *  guard   纯逻辑：看板分组、卡住 / 反复卡住判断
 *  exec    在负责人自己的任务会话里执行、提交、汇报进展
 *  actions 创建 / 派活 / 核验 / 编辑 / 开始 / 继续 / 暂停 / 取消 + 群生命周期钩子
 *  watch   卡住检测、上报、「等你决定」
 *  correction 群里自然语言纠正：任务识别与本轮许可
 *  tools   模型工具；ports 任务 ↔ 群的窄接口
 * 设计见 docs/design/durable-work-items.md、docs/design/group-collaboration.md。
 */
export * from "./work-items/store.ts";
export * from "./work-items/guard.ts";
export { bootstrapWorkItems, cancelWorkRuns, execConversationsOfRoom, execOf, finishRun, liveRunOf, reportProgress, steerToLiveRun, submitWorkItem, workPrompt } from "./work-items/exec.ts";
export * from "./work-items/actions.ts";
export { answerDecision, askUserDecision, checkStalls, escalate, startWorkWatch } from "./work-items/watch.ts";
export * from "./work-items/correction.ts";
export { workExecTools, workItemTools } from "./work-items/tools.ts";
export { currentSource, setRoomPort, setWorkSourceProvider, type RoomPort } from "./work-items/ports.ts";
