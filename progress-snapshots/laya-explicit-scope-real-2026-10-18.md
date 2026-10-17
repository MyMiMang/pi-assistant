# Laya 显式候选范围：接口真验与下一步决策

时间：2026-10-18 00:21–00:29（Asia/Shanghai）。起点 `47db9aa`；本地候选，未发布。

## 实际补齐

产品 `fast_pick_action` 已支持 `candidates`，但 stepwise 测试控制面原来未透传此字段。仅改 `scripts/laya-benchmark-handoff.mjs` 与 isolated harness：白名单提取 2..32 个 `{role?,label}`，传给真实注册的 handler，并记录到原始报告；自由参数不透传。产品运行时代码未改。新增控制面透传检查，`node --test scripts/laya-benchmark-handoff.test.mjs` 16/16 通过。

## 单次真实验收

使用相同已知 stepwise 页，目的仅是新 scope 接口贯通及 fallback 接管验收，**不是新页面质量基准**，不把较小候选集合与此前成绩比较。未调 prompt、阈值 0.6、概率公式或模型；无 raw 额外请求，无重跑。

| 当前观察后圈定的完整集合 | 当前一步目标 | 实际结果 |
|---|---|---|
| combobox 导出格式 / 报告语言 | 点击导出格式下拉框 | 正确选导出格式，gate 0.6894，协议 confidence 0.3769，handler 2907ms；后续真实快照出现 CSV/JSON |
| option CSV / JSON | 点击 JSON 选项 | low_confidence 回退；最高选项概率 0.5138，gate 0.02760000000000007，协议 confidence 0.0005，handler 732ms；未派发 |

两次请求均通过真实注册工具、生产 buildChooser、本地真实 multilingual、同一自有 MCP/driver/browser。机器状态和 UI 由独立读取得到，不进快模型输入。

主会话回退后重新 observe，独立选 JSON、报告语言、中文、预览、确认五个新 ref，全部 trusted click；最终 UI 与机器一致：`selected:"JSON:中文",step:2,clicked:"confirmed"`。任务完成依赖主模型五次点击，不能称快模型独立完成。

控制面任务 wall 450365ms，包含主会话工具、推理和约 4 分 40 秒的调度空档（00:23:01–00:27:43）；不能作为快路径或自动化吞吐成绩。

原始报告：[report-2026-10-17T16-21-03-044Z.json](../evidence/laya-benchmark-real/report-2026-10-17T16-21-03-044Z.json)，保留原始内容。报告旧任务级 summary 的 `fallbacks:0` 仍不适用于 stepwise，使用 `fastStepKinds:{selected:1,fallback:1}`。

## 隔离与恢复

服务 synthetic HOME/TMP/DATA/WORKSPACE、内存凭据；原生启动使用 OS HOME，环境证据仅为启动输入，非实际子进程完整环境。root `/tmp/pia-lb-amv7oy7ejb00-mvclslkt`。外监护 `phase:finished,exitCode:0,cleanup.ok:true,failures:[]`；自有 daemon/socket/model 均退出；新鲜进程白名单无本次 root 残留。原生产 Laya 经正常 API 恢复，独立 GET 确认 running、health.ok、MPS、multilingual；没有修改模型选择。PID/port 仅是本次证据，不用于未来盲停。

## 判断和下一步

scope 接口实测贯通；即便只剩两个真实选项，通用 multilingual 仍接近随机分布而回退。结合此前高分误选，不适合作为可靠性默认推荐。此两例不能推导总体准确率、中文能力或权重优劣，也不构成新候选范围的质量证明。保留可选、主模型接管与原用户设置。

建议下一步是浏览器专项 v19s 的有限实验，**等待用户对新增权重下载的选择**：

- 固定 `cklxx/laya-browser` revision `645cf366a2ae35f1086e8c20eff48f909bb49206`，主权重 643835524B（约 644 MB，另有少量配置）。先核对既有研究中的文件 hash 与许可证/归属要求。
- 临时实验目录，与现有已选模型隔离；不写产品目录、不注册推荐卡、不更换用户配置、不发布。
- 首先验证 Apple/MPS 能否实际加载；失败即停，不改用户运行环境或反复重装。
- 如能加载，按 checkpoint 的 v5 训练格式构造完整可见动作、观察状态与历史，运行一组未用于调试的新页面；主模型观察并判断目标，动作仍走真实工具和独立核验，不按答案删候选。
- 一次有限运行、保留原始结果；不调阈值、不针对页面改词、不用第三方英文成绩冒充中文本地效果。实验后退出独占进程并恢复原生产模型。

不下载的路径：当前通用模型保留实验性可选入口与 fallback，结束本轮质量研究，继续其他产品验收。当前公开版仍 beta.29；没有 push/tag/package/install。
