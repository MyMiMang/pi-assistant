# Laya 输入去重后真实测量（2026-10-17）

代码 d9cc50e，主会话核对 diff、定向测试37/37通过后，只启动一次 supervisor 监护的真实操作测试。state 仅保留 goal、候选完整保留 criteria；原模型、原 0.6 门槛和 4000ms 超时不变，无额外 raw 推理、无失败后重跑。

| 任务 | 比较值 gate | 选项概率 | 结果 |
|---|---:|---:|---|
| 提交 | 0.8109 | 0.8380 | selected，双证据 correct |
| 城市 | 0.0993 | 0.2280 | low_confidence，未执行 |
| 深度目标（程序滚动后） | 0.3936 | 0.4802 | low_confidence，未执行 |
| 动态两步 | 0.1707 | 0.2892 | low_confidence，未执行 |

汇总仍 **1/4 correct**，没有超时。此前 13:59 轮成功的是深度目标，提交返回；本轮相反。去重明显改变分布，但没有本轮整体完成率提升的证据。四题单机/单轮不能推广为整体准确率，不再围绕同四题调提示或阈值凑通过。

决策延迟176/210/447/716ms，p50 210ms、p95 716ms，为每题最后一次 decision，不是任务总耗时。本次不执行主接管，主接管已在14:34轮另验3/3，不混算。

外监督 `/tmp/pia-lb-amv7oy7ejb00-mvcieka4/supervisor-state.json` finished、exit=1（评分非全过）、cleanup.ok=true、failures=[]、prodRestored=true。主会话 fresh API核原模型 running pid99567 port54859、health.ok=true/mps；fresh pgrep 本次根无进程残留。本次服务临时 HOME，原生边界OS HOME；输入配置证据仍不能当最终子进程环境读回。

原始报告 `evidence/laya-benchmark-real/report-2026-10-17T14-46-09-287Z.json` 原样保留。日志 `dedup-20261017T144609Z.log` 本地留盘（gitignore）。候选未推送/打包/安装，用户设置未改。

原文路径核对：主会话确已读工作区研究克隆，不在项目工作树。仓库留可追溯摘录 [浏览器候选输入来源](../docs/research/laya-browser-input-source.md)。上游小模型专项训练结果不等于本机结果，当前通用 multilingual 在本组任务仍未达目标。

下一步转向浏览器专项 checkpoint 的许可、语言、真实输入契约、体积和现有一键组件接入可行性；先源代码/元数据核查，不自动下载权重、不替换用户模型。保留当前 Laya 可选项与已验证主模型回退。
