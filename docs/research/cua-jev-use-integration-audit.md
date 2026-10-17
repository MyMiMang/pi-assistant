# CUA jev-use 与 Pi Assistant 当前快速模型接入对照

2026-10-17 主会话只读核对。源是本机 `/Users/dengdeng/Documents/AI/cua-jev-use`，origin `https://github.com/trycua/cua.git`，HEAD `f25fe3691e651cc8ac6adf92931940ed25d9a6bb`。未 fetch 更新、未启动示例、未调用 Jev 服务、未下载模型；本机快照不能称最新上游。

此前 `research/jev-multichannel-evaluation.md` 引用过该示例的协议和适配器。本轮重新检查完整候选构造与执行流程，发现当前产品实现只复用了其中一部分，不能称等价接入。

## 实际源码与关键差异

源码路径均相对 CUA 仓库：

- `libs/cua-driver/examples/jev-use/README.md`：示例是任务规格、候选来源、模型选择、执行、独立判分构成的有限循环；不是 Driver 自动获得规划能力。
- `python/jev_adapter.py`：`choose_for_task` 用 `task_decision_state` 传入 goal、页面/表单状态/outline/可选视觉摘要、bounded history；criteria 是候选 id→完整动作 description。`choose_bounded_with_typesafe` 另有更小接口，以 goal 作为 Choice.instructions、state 放 observation。
- `python/tasks.py`：`FixtureFormTask.candidates` 依据已观察状态提供完整动作。例如字段未含目标值时提供“替换字段内容”；字段已含目标值才提供“点击 Submit”；额外提供 `reobserve` / `abstain`。这是测试任务专用的程序逻辑，不是 Jev 自己推理出了所有动作，不能照抄成我们的测试答案或泛化为任意网站能力。
- `python/sources.py`：候选是不可变的 id/description/tool/arguments；模型只看 id/description，真正工具和参数留在 runner。DOM 快照与原生 AX/可选视觉来源分开。网页 click 示例明确用 dom_event，原生输入/风险规则由任务决定。
- `python/native_tasks.py`：声明式步骤、先后依赖和 progress 由本次成功执行日志计数，不能用模型自评或测试预期充当当前状态。
- `python/run.py`：保持一个 MCP 连接，每步重读页面、构造候选、调用模型、处理保留选项、执行后读独立 oracle，受 step budget 限制。不是示例自动再请求主 LLM 接管。
- `decision-models.md` 与 `python/decision_models.py`：分 selected/reobserve/abstain/error；检查完整候选概率集合、有限范围、总和约1、唯一 argmax、choice 与概率一致；selected 不代表授权或成功。文档建议跨模型比较使用 `probabilities[selected_id]`，provider confidence 原样保留。

## 与当前产品的关系

| 能力 | CUA 示例 | Pi Assistant 当前候选 |
|---|---|---|
| 快模型职责 | 从完整可执行动作中挑一个 | 主要从 click 控件标签中挑一个 |
| 输入状态 | 任务目标、紧凑观察、表单状态、历史；native 另有 progress | 目前 classifier state 仅 goal，criteria 仅 role+label |
| 多步流程 | 任务特定候选构造，每步重读并判断 | 主模型负责拆步骤；快速工具本身一次点击 |
| 动作种类 | 示例任务可以 type/click 等，参数预先由调用方确定 | 当前公开快速工具点击白名单 |
| 放弃选择 | reserved reobserve/abstain 作为明确选项 | 当前通过低置信度、模型错误等返回主会话；没有相同的reserved choice |
| 主模型接管 | 该示例不自动调用主 LLM | 主会话已在隔离页实测三题接管完成 |
| 模型 | TypeSafe Jev；可另接本地 CUA-S1 | 本地通用 Laya multilingual；与 Jev 不是同一个模型 |

这是实际设计差异，不能单凭对照就证明低置信度全部由此引起，也不能说明照抄示例就能让 Laya 达标。上游任务在某些阶段只提供一个合法动作加保留选项，比当前七个控件一起选择更受约束；其成功数字不能和本产品四题直接横比。

## 下一实施顺序

先暂停把更换浏览器专项 checkpoint 当成已确定方案，专项模型继续只做备选元数据核查。

1. 保留主模型规划与当前一次点击工具边界，明确快速工具的 goal 应是当前一步。不能把“先展开再选北京”的两步目标直接当作一次点击选择质量的通用测量。
2. 输入适配增加由当前快照已观察事实生成的紧凑语义状态、动作描述；不带坐标/工具参数/凭据/随机capture标识，不注入测试答案。候选例：“点击名称为城市的下拉控件，展开可选项”，不只是“combobox：城市”。不能把未知后置状态写成已观察事实。
3. 有限历史/步骤进度应复用运行时已有来源，只记录实际观察或成功操作；不为一个 chooser 新造另一套自主规划状态机。需要证明能安全脱敏并稳定绑定同目标。
4. reobserve/abstain 与完整概率验证可按当前扩展模块实现，避免改 Pi/Driver。若扩充 reserved 候选会改变候选数量和 gate 标度，必须单独验证，不悄悄放宽门槛。
5. 当前0.6属于既有Jev标度，直接改用max(p)仍沿用0.6会放宽接受率。先明确阈值契约和迁移，不能借对齐文档名义直接变门槛。

本轮仅核对源码并记录差异，尚未做以上产品变更。下一验证用与一次工具调用相匹配的局部目标、独立页面状态、未见过的控件和多步真实链路；不要只对已知四题调词直至过关。
