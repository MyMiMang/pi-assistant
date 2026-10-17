# Laya 浏览器候选输入格式：本机上游源码核对

主会话于 2026-10-17 完整读取工作区研究克隆的 `research/laya/docs/finetune_browser_agent.md`。该路径相对于助理工作区，不在 pi-assistant 工作树内部；此前子代理在工作树内未找到文件，不代表主会话没有读过。为便于他人接手，摘录与边界留在仓库。

源码基线：`cklxx/laya`，commit `432312b36714d8889eba405507b37eda25257d9c`；路径 `docs/finetune_browser_agent.md`。上游链接：https://github.com/cklxx/laya/blob/432312b36714d8889eba405507b37eda25257d9c/docs/finetune_browser_agent.md 。引用文档是源码说明，不是本产品或安装版实测。

与本次去重直接有关的原文（What mattered most: the input format）：

> With jev's state passed verbatim (page text + the whole element table as JSON inside `state`) the 1,024-token window truncates most of the table, so the model often never sees the candidate it should pick. Moving elements out of the state and into the option list (full label + role + current value, head_max_len 512 → 768; state keeps title / URL / history / 1.2–1.5k chars of text) was worth more than any data change.

文档同时报告专门浏览器模型的训练结果，通用 typed-decisions 在其浏览器评测上表现差，专项模型改善明显；不能推断本机 multilingual 的准确率，也不能仅凭文档断言本产品旧输入一定发生截断。本次 7 个候选并无已测的截断证据。

产品 d9cc50e 只去掉 state 中重复的候选表，state 留原 goal，全部 id/label 完整保留在 criteria。不改变 instructions、模型、用户配置、门槛或温度。它是参考上述格式建议的小范围适配，不包含上游的专用训练、head 长度调整、页面历史/URL上下文，也不是复现上游训练结果。

去重前接管验收与去重后质量测量须分开；纯测试通过不代表模型质量提高。中文语言覆盖、专用模型许可、大小和一键安装尚未审计，不自动下载或替换用户所选模型。
