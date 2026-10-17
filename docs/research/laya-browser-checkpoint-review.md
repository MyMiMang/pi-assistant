# 浏览器专项 checkpoint（cklxx/laya-browser）源核与接入决策

> 2026-10-17，分支 `laya-benchmark-snapshot-fix`。**只做公开源 / 元数据核查**：读 HF API / tree / 小文本文件（≤1 MB）、
> 读本机已安装的 `laya==0.4.8` 源码、读 CUA 官方 `jev-use` 示例源码。**没有下载权重、没有起模型 / 浏览器 / daemon、
> 没有改用户设置 / 模板 / 门槛 / 执行范围。**
> 结论一句话：**它是备选方案（不是已定换型）：中文覆盖 / 本机加载 / 分发义务尚待核验；当前先做 CUA 接法（动作语义等）改进，不进入下载 / 换模型。**


> **2026-10-18 状态更新（覆盖 §8「后续最小测量」）**：用户已决定**不继续**本专项模型（「先用通用选择模型，遇到不会的主模型会接手」）。只发生过一次**部分下载**（固定 revision `645cf366…`，隔离实验根保留 97MB，`model.safetensors` 不完整），**未校验大文件、未加载、未起 sidecar、未暂停生产 Laya、未注册模型**。新脚本 `scripts/laya-browser-v19s-{experiment,supervisor}.mjs` **未运行**、不得当产品能力。另：`laya-browser` 的 v5 动作空间 / `page.text` / 字段摘要 / `recent_actions` **只覆盖网页分支**，原生窗口 AX 路径仍走现有收集器，必须保留；本机 Apple/MPS 只是本机证据，不绑死平台。详见 HANDOFF 顶条。

## 1. 结论（可执行判断）

| 问题 | 结论 | 依据 |
|---|---|---|
| 许可能否分发 / 商用 | **元数据层面无冲突**（本仓 Apache-2.0，上游逐层声明见 §2.2）；**不等于**训练数据全部义务已自动闭合 | §2.2 |
| revision 能否固定 / 校验 | **能**（已取到 commit + 每个必需文件的 size/SHA256，无需下权重） | §2.3 |
| 体积 / Apple 运行时 | **体积已核**（643,835,524 B）；**Apple 能否真跑属源码/配置推断，未真实加载，不得说“能跑”** | §2.4 / §3 |
| 输入契约能否用现有运行时实现 | **按源码推断可以**：v5 格式全在客户端构造，`/v1/systemone` 收 `state`+`questions`、`model` 选 checkpoint；**未真机验证** | §3 / §4 |
| 中文覆盖 | **未验，且现有证据不支持**（训练与评测均为英文站点；card 的 `multilingual` 只是词表声明） | §5 |
| 现在能否上线成卡片 | **不能**（中文未验 + 准确率未在本机测；不允许空卡片 / 未验标推荐） | §6 |

因此本轮交付：**本决策文档 + 一段研究用纯函数 input adapter + 单测**，都放在 `scripts/`（不是产品代码）：
`scripts/laya-browser-input.ts`、`scripts/laya-browser-input.test.ts`（8/8 通过，跑法 `node --test --import tsx scripts/laya-browser-input.test.ts`）。
**catalog / manifest / UI / `packages/server` 一律没动**；adapter **未经主审不得上线**，也不得被产品模块 import。

## 2. HuggingFace 源核（公开 API，无需 Key，未下权重）

### 2.1 仓库与版本现状（重要纠偏）

- 仓库 `cklxx/laya-browser`，`private:false`、`gated:false`、`downloads:791`、`likes:34`。
- `main` 的 commit：**`645cf366a2ae35f1086e8c20eff48f909bb49206`**（`lastModified 2026-09-29T09:26:42Z`），无 tag、无分支别名。
- README 明写：**“One model, at the repo root (v19s). Earlier checkpoints are in the commit history.”**
  → **`v10` / `v10s` 不在当前仓库文件里**，只在 git 历史中；现在根目录那份是 **v19s**。
  所以“专项 checkpoint”应当按 **v19s（revision 645cf366）** 评估，`v10s` 的 17–23 ms / 62% 是历史版本成绩。
- 参数规模：`model.safetensors` 643,835,524 B ÷ 2（fp16/bf16）≈ **322M**，与 card 的 `mmBERT-base 322M` 一致；
  421M 是另一个 backbone（对应 `convaiinnovations/laya-typed-decisions` 的 842,609,220 B），**不是本仓库**。

### 2.2 许可元数据（只说明“查过上游声明”，不代替法务结论）

| 层 | 上游声明 | 说明 |
|---|---|---|
| `cklxx/laya-browser` | `license: apache-2.0`（card frontmatter + `license:` tag） | README 另写 “License: Apache-2.0, same as laya” |
| 基座 `convaiinnovations/laya` | `apache-2.0` | 我们已在 `THIRD_PARTY_NOTICES.md` / manifest 记录 |
| encoder `jhu-clsp/mmBERT-base` | `mit` | 分发时需保留 MIT 声明 |
| 训练数据 Mind2Web / WebChain | `cc-by-4.0` | 上游注明 “training only”；**衍生权重的署名 / 使用义务没有逐条审过** |
| 训练数据 NNetNav-live | `apache-2.0` | — |

结论（严格版）：**元数据层面没有互相冲突的声明**，分发与商用**看不到许可阻塞**；但这只是读上游 card 的结果，
**不等于**训练数据（尤其 Mind2Web / WebChain 的 CC-BY 义务、以及各数据集 ToS）的义务已全部闭合。真要随产品分发，
需要一次专门的许可复核（谁署名、NOTICE 放哪、是否要随包附数据集声明）。

### 2.2b 我们的翻译代码必须保留来源（Apache-2.0 §4）

`scripts/laya-browser-input.ts` 是上游 `laya_browser.py` 的逐条翻译，属 Apache-2.0 衍生：已在
[`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) 补一条，写明来源、revision、许可证与保留义务。

### 2.3 固定 revision 与文件清单（下载后校验用，未下载）

`laya.load(dir)` 只需要 `rl_agent_config.json` + `model.safetensors` + `tokenizer/*` + `encoder/*`（`laya/agent.py:590` 的 allow patterns）。
其余（`config.json`、`modeling_laya_browser.py`、`laya_browser.py`、`code/`、`results/`、`assets/`）**不是加载必需**，且 `.py` 按我们清单规则不允许进下载集。

| 路径 | size (B) | SHA256 | 来源 |
|---|---|---|---|
| `.gitattributes` | 2106 | `98cd84714c4e072e237100fefa38d4d88770059e157926cefc7a17f4689469ae` | 下载后本地算 |
| `README.md`（optional） | 8512 | `09dd7dc3675472a53ee8ab2996ae28ba7831e384503d889947b9811959f540e2` | 同上 |
| `encoder/config.json` | 1968 | `252795756225d703e1913d5647eb542ded520cfd6684f232cc8f4a5ccb6faf9d` | 同上 |
| `model.safetensors` | 643,835,524 | `82844f2528b9915f8408146384409ccc99f860f56ba0e37d19d0d5775b098e52` | HF LFS oid |
| `rl_agent_config.json` | 561 | `b78796b604532688de6749c61912503cc89b2f998a07b06ef27c280989a34eea` | 下载后本地算 |
| `tokenizer/tokenizer.json` | 34,363,188 | `609d8f4c067cd3950f88594c5a802616cea245823836ef5848ee4fc40aab5b6f` | HF LFS oid |
| `tokenizer/tokenizer_config.json` | 624 | `f2ff584a8f78ac9f3b6fd0afcf9ab310e41c2d445ef628f9ab4b0d594e992b7a` | 下载后本地算 |

注意：`tokenizer/tokenizer.json` 的 SHA256 与现 `laya-multilingual` 清单**完全相同**（同一个 mmBERT 词表）；
`model.safetensors` 比 multilingual 大 **10 B**（643,835,524 vs 643,835,514）——同 backbone、不同 head。
**下载 / 校验可以完全复用现有 `local-laya` 的 `downloadCheckpoint` + `verifyCheckpoint`，不需要新进度条。**

### 2.4 配置差异（`rl_agent_config.json`，逐字读取）

| 键 | laya-browser v19s | laya-multilingual（现装） |
|---|---|---|
| encoder | `jhu-clsp/mmBERT-base` | 同 |
| max_len / head_max_len | **1024 / 768** | 1024 / 256 |
| temperature | **`[4.5551, 1.0, 1.0]`（已拟合）** | `[1,1,1]`（未拟合 → 偏 over-confident） |
| max_options / page_text_chars | 60 / 1200 | — |
| `laya_fmt` | **`v5`** | 无（laya 通用格式） |
| amp_dtype | bf16（仅训练用） | bf16 |

`config.json` 是给 `transformers` + `trust_remote_code` 用的（`AutoModel`），我们**不需要**它；`encoder/config.json` 里
`reference_compile: false` 已经关掉，所以上游 `laya_browser.py` 里那句 `encoder.config.reference_compile = False` 的补丁**也不需要**。

## 3. 运行时兼容（读本机已装 `laya==0.4.8` 源码得到的**推断**，未真实加载）

下面每一条都是**源码/配置层面**的事实，组合起来的结论是“设计上能接”，**不是“已经在 Apple 上跑通”**。

- `laya/agent.py:2083 load()`：接受本地 checkpoint 目录（目录里有 `rl_agent_config.json` 即可），`cfg` 里的
  `head_max_len=768` / `max_len=1024` 会被 `predict` 自动采用（`agent.py:1135`），**不需要**客户端再传。
- `laya/serve.py:1337 _systemone_inner`：请求体只要求有 `questions`；`state` 原样进 `router.predict`；
  `model` 字段经 `_resolve_model` → `router.resolve`，**`LAYA_EXTRA_MODELS` 注册的名字也能被指定**；
  `max_len` / `head_max_len` 可逐请求覆盖；`MAX_CHOICE_OPTIONS = 100`、`MAX_QUESTIONS = 64`、`MAX_STATE_CHARS = 50000`。
- Pi 侧 SDK（`@earendil-works/pi-ai` 的 `typesafe-system-one`）payload 是 `{ model: model.id, ...request }`：
  **同一个 sidecar 上注册第二个 classifier modelId，Pi 就会带上 `model` 字段**——不需要改 SDK、不需要第二个进程。
- `laya 0.4.8` **没有** `laya_fmt` / 浏览器格式支持（`grep laya_fmt` 无命中）：格式必须由**客户端**按 v5 构造。
  上游 README 的 `laya.load(...)` 只给原始模型，格式在仓库的 `laya_browser.py` 里，而且**该文件只做“构造 state + questions”，
  再调公开的 `agent.predict`**——所以正确用法**不需要执行仓库里的 .py**，把那段构造逻辑搬到我们这边即可（已做，见 §6）。

## 4. v5 输入契约（据此实现，已逐条对照 `laya_browser.py`）

- **state**：`{fields, page:{url,title,text[:1200]}, recent_actions[:10]}`；`fields` 是表单摘要（最多 14 条，
  形如 `Search packages = (empty)` / `Sort = 'Relevance'` / `Subscribe: checked=False`）。
- **questions**：`operation`（选项 = 出现过的 CLICK / TYPE_TEXT / SELECT + 控制项 + DONE + BLOCKED）
  与每个操作一个 `<op>_target`；目标选项是 `criteria` 的 key（元素编号，`<select>` 用 `4:2`），
  值是 v5 紧凑串（`argo (link)`、`Search packages (searchbox) = 'vim'`、`Sort → Downloads`）。
- **宽选择**：>60 候选时按 `i % n` 交错切块、**一次请求**发全部块，块赢家再问一次，
  `p(选项) = p(块赢家) × p_块内(选项)` 再归一。
- **答案**：先看 `operation`，再取 `${op.toLowerCase()}_target`；`DONE` / `BLOCKED` 不是动作。
- 我们现有 `createClassifierChooser`（`state={goal}` + 单个 `pick` 问题、候选只放 label）**与 v5 不同**：
  同一份模型输入不对等，所以**不能用现 chooser 直接喂这个 checkpoint**。

## 5. 中文覆盖：未验，且现有证据不支持

先统一原始证据（两处 card 字段，逐字）：

- README 的 YAML frontmatter：`language:` 下两行 `- en`、`- multilingual`。
- HF API 的 `cardData.language`：`["en", "multilingual"]`（与上面同一份 card 的解析结果，不是两套声明）。

所以“card 写的是 en”这个说法**不准确**：它同时列了 `en` 和 `multilingual`。但 `multilingual` 是**基座词表/多语种声明**，
不是“中文网页任务已训练”的证据：

- 训练数据（README 逐条）：Mind2Web / NNetNav / WebChain + 421 个英文站点（Wikipedia / GitHub / HN / arXiv / HF / demo shops），
  goal 由本地 Qwen3-8B 反向生成；评测套件 A/B/C 全是英文站点。
- 所以**中文网页 / 中文标签 / 中文目标**没有任何实测数据。这是**当前最大 blocker**，而且它决定产品是否该把它当“中文可用”。
- 最小可测：一个中文 fixture 页（中文按钮 + 中文表单 + 中文目标），看 operation 与 target 是否仍能选对；**不跑就不能写“支持中文”**。

## 6. 与 CUA 官方 `jev-use` 的真实用法对比（读源码，不是转述）

来源（绝对路径）：`/Users/dengdeng/Documents/AI/cua-jev-use/libs/cua-driver/examples/jev-use/`
（repo HEAD `f25fe3691e651cc8ac6adf92931940ed25d9a6bb`，`python/{jev_adapter,decision_models,tasks,sources,core,run}.py`、`decision-models.md`）。

### 6.1 官方做法（事实）

| 维度 | CUA jev-use |
|---|---|
| 候选粒度 | **完整动作**：每个候选是一份**预构建的 Driver 动作**（`page.type_text(...)` / `page.click(...)` / `visual.click(...)`），带 `candidate_id` + `description`（含**前置条件**，如“字段已含所需 token，可直接提交”） |
| 候选集合 | **闭合**且**任务相关**：只 offer “当前观察下**下一个可执行**的动作”（`FixtureFormTask.candidates` 按 `field.value` 分支），外加两个**保留候选** `reobserve` / `abstain` |
| 模型输入 | `state = {goal, observation:{page, form, outline, visual}, history}`；`form` 是 runner **自己核验过的状态摘要**，不是让模型从 outline 猜；`history` 只记 `{step, selected_id, outcome}`（不记耗时 / 概率，避免“重复自己”变成信号） |
| 问题 | 单个 `driver_action`（`Choice(instructions=goal, criteria={id: description})`），指令语义是“选出可执行的下一步” |
| 门（gate） | **model-independent**：`probabilities[selected_id]`，不是 provider 的 `confidence`；并列最高 = 不可执行；概率和须 ≈1；`selected` 必须等于 argmax；**示例里没有 min_score**，`decision-models.md` 明写“caller 应自己再加最低分 / 间距” |
| 四种结果 | `selected` / `reobserve` / `abstain` / `error`；后三者**不派发动作** |
| 循环 | 每步 **fresh observation**（`get_browser_state semantic_v2`）+ `max_steps` 预算；`selected` 后还要用**原始观察**复核前置条件再派发，事后独立核验 |
| 回退 | **没有**“SDK 原生 / 主 LLM 自动接管”；模型选 `abstain` 就结束，`budget_exhausted` 是一种结局 |
| 秘密 | 任务参数 `secret=True` 在**所有模型输入**里被替换成 `[verification token]`，只有可执行参数里保留 |

### 6.2 与 Pi 现在 `fast_pick_action` 的差异（决定下一 patch）

| 维度 | Pi 现在 | CUA jev-use | 影响 |
|---|---|---|---|
| 候选粒度 | 只有 **click 候选**（`id` + `label`），不含“动作类型 / 前置条件 / 完整动作” | 完整预构建动作 + description + preconditions | 模型无法区分“填值 vs 提交”，也没法表达“已满足” |
| 问题语义 | `pick`：“从候选里选最符合目标的一个 id” | `driver_action`：“选出**可执行的下一步**” | 语义不同，直接换模型/换 checkpoint 都不会自动对齐 |
| 保留候选 | 无（没有 reobserve / abstain 选项） | 有，且是**显式候选** | 我们只能靠阈值 + fallback 表达“不选” |
| 门 | 用 **jev 换算** `(max(p)-1/n)/(1-1/n)` 比 0.6 | 用 **`probabilities[selected_id]`**，示例无阈值 | **不是同一个量**；未经约定不能把 0.6 换成 p 当“更宽的门” |
| 状态 | `state={goal}`（去重后） | goal + page/form/outline/visual + bounded history | 我们没给表单状态 / 历史，浏览器任务信息量不足 |
| 回退 | 低于阈值 → 交回主模型（`fast_pick_action` 返回说明） | `abstain` 结束，不自动接管 | 我们的 fallback 是**产品选择**，与 jev-use 不同层 |
| 作用域 | 只选一个动作，不跑整条自动化 | 跑任务循环（每步 fresh + budget + oracle） | **保持我们现在的 scope 是对的**，不需要照搬整条循环 |

### 6.3 可复用的最小改动（不改变用户设置 / 模板 / 门槛 / 执行范围）

按“先 source 审、再小实现”的顺序，每一步都能单独回滚：

- **P0（本轮已完成，研究 fixture、未接线）**：`scripts/laya-browser-input.ts` 实现 v5 的 `actionSpace / compact / fieldsSummary / buildRequest /
  splitWideChoices / mergeChunkedAnswers / interpret`。只证明“格式可复现”，不碰运行时、不改任何阈值、**不进产品 src**、未主审不上线。
- **P1（下一 patch，仍然不换默认模型）**：把候选语义从“label”扩成“**动作描述 + 前置条件**”（照 jev-use 的 `Candidate`），
  并给 chooser 一个**可选**的 `state` 扩展（`page` / `form` / `outline` / `history`）。默认路径（multilingual + 现模板）
  输入**保持不变**，只在显式选择浏览器 checkpoint 时启用；`reobserve` / `abstain` 作为**保留候选**加进去，
  但**不改变**现有阈值与 fallback 行为（选到它们时按现有“交回主模型”处理，并记录原因）。
- **P2（需要用户授权下载后才做）**：manifest + `checkpoint-files` 加 `cklxx/laya-browser`（revision `645cf366…`、§2.3 的哈希）、
  manager 支持“同一 sidecar 两个 checkpoint + 两个 modelId”（`LAYA_MODELS` + `LAYA_EXTRA_MODELS`，§3 已验证可行）、
  UI 普通可选卡片，**复用**现有下载进度 / 校验 / 运行时管理，**不替换** multilingual。
  卡片文案不得写“中文支持”“推荐”，除非 §5 的中文 fixture 真跑过。
- **门槛单独决策**：若要给浏览器 checkpoint 用 `probabilities[selected_id]`，必须**单独约定**，不能顺手把 0.6 解释成 p；
  本文件不做这个决定。

## 7. 未验 / 不得宣称

- 没有下载权重、没有加载、没有推理：**本机准确率、延迟、MPS 实跑全部未知**。
- README 的 62% / 11–14/54 / 0.66 top-1 是**上游在 RTX 4070 Ti SUPER 上的报告**，不是本机证据。
- 中文覆盖**未验**；`language: multilingual` 不能当能力证据。
- `laya 0.4.8` 能加载这个目录**只按源码推断**（`rl_agent_config.json` + 同结构文件），未真跑；`laya_fmt: v5` 被 0.4.8 忽略（它不读这个键），
  格式差异全部靠客户端构造补上——这条**未在真机验证**。
- CUA jev-use 的结论来自读示例源码，**未运行**它的 fixture / provider。
- 旧四题（提交 / 城市 / 深度目标 / 动态）本轮**没有重跑**，也不该拿它们给新 checkpoint 打分。

## 8. 备选路线的后续最小测量（**未进入当前工作**，需单独授权，按顺序）

1. 只下载并校验该 checkpoint（复用现有进度 / 校验，SHA256 见 §2.3），确认 `laya.load(dir)` 在 MPS 上能起、`/health` ok。
2. 用 §6.3 P0 的纯函数发**一条** v5 请求，确认 `operation` + `*_target` 有合法答案（链路证明，不是准确率）。
3. 中文 fixture（§5）：一个中文按钮 + 一个中文表单 + 中文目标，看 operation / target；**失败就写“不支持中文”，不调阈值凑**。
4. 只有 1–3 都过，才谈 P2 卡片与“推荐”字样；准确率对比仍要独立 fixture 与多次运行，不能用一次结果。
