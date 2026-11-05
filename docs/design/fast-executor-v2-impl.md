状态：已实现(75f2c03)（第二版实现方案，2026-11-05；真机测速见 fast-executor.md 末尾；第一版见 [fast-executor-impl.md](fast-executor-impl.md)，总设计见 [fast-executor.md](fast-executor.md)）

# 快速执行者第二版：少问大模型（打开 + 带回结果 + 目标模式）

> 先通读：`AGENTS.md`、`docs/design/fast-executor.md`（尤其最后「实现后的状态」）、`docs/design/fast-executor-impl.md`、
> 现有代码 `packages/ext-computer/src/quick-steps.ts`、`quick-steps-tool.ts`、`index.ts`。
> 本文件把每个文件、每个函数、每个判断都写死了，**照着做，不要自己改设计**。哪里写得不清楚，停下来问，不要猜。

## 0. 为什么要第二版（真机数据）
2026-11-05 真机：同一个网页表单，整体 121 秒 → 108 秒。108 秒里**约 96 秒是大模型想了 9 轮**（每轮 8–20 秒），cua 执行 + 快速执行的 6 步只用了约 12 秒。
9 轮分别是：开浏览器、找窗口、绑定、打开网址、读页面、写快速执行、**做完又读一遍页面看结果**、结束会话、回答。
所以要省的是**大模型的轮数**，不是点击速度。cua 官方 jev-use 的做法：大模型只给一次目标和要填的值，之后每一步由 Jev 决定做什么。

三件事（**都要通用**：网页、用户电脑上的桌面应用、助理电脑里的窗口都走同一套，不为浏览器单独写）：
1. **打开工具 `*_quick_open`**：给网址或应用名，程序一次做完「开浏览器 / 开应用 → 找窗口 → 绑定 → 打开网址 → 读结构」，返回 target 和页面内容。5 轮变 1 轮。
2. **带回结果**：`*_quick_steps` 做完（或停下）时，把最后一次读到的页面 / 窗口内容（文字摘要）一起返回，大模型不用再读一遍。
3. **目标模式**：`*_quick_steps` 除了 `steps`，还能传 `goal` + `inputs`：每一步由程序列出候选动作、Jev 挑一个、cua 执行、核对，循环到 Jev 选「完成」，交回大模型审核。

## 1. 已经确认的事实（不用再查）
- 第一版的事实（`ctx.executeTool` 照常过审批闸门、`ctx.modelRegistry.classify`、`findOfType`、`unwrapStructured`）都还成立。
- 嵌套调用的 `structuredContent` 已修好（commit 79067ab），`get_browser_state` semantic_v2 的结构化结果里：
  - `refs`：可操作元素数组，每项 `{ ref, role, name, value, actions: string[], states, visibility }`，例如 `{ref:"p3:0", role:"textbox", name:"名称", actions:["type","pointer"]}`、`{ref:"p3:2", role:"combobox", name:"分辨率", value:"请选择", actions:["click","pointer"]}`。
  - `content_refs`：不可操作的文字（标题、说明、提示），同样的字段。
  - `outline`：整页的文字大纲（字符串，多行，例如 `- heading "生成任务"\n- form\n  - textbox "名称" …`）。**这就是「页面内容摘要」的来源。**
- cua 工具参数（`cua-driver describe` 读出来的）：
  - `browser_prepare { allow_launch:true, profile:{mode:"isolated_new"}, session }` → 结构化结果里有 `prepared_pid`（新开的独立 Chrome 进程号）。连用户正在用的 Chrome：`browser_prepare { pid, window_id, session, strategy:{kind:"existing_profile"} }`。
  - `list_windows { pid?, app?, session }` → `windows[]`，每项 `{ window_id, pid, app_name, title, z_index, is_on_screen }`。最前面的窗口取 `z_index` 最大的。
  - `get_browser_state { pid, window_id, session }`（绑定模式）→ `target_id`、`tabs[] { tab_id, active, url, title }`、`binding_quality`、`mutation_allowed`。
  - `browser_navigate { target_id, tab_id, session, url }`。
  - `launch_app { name? , bundle_id?, session }`（后台启动，不抢前台）。**返回里的进程号字段名没确认**：按顺序试 `pid`、`process_id`、`app.pid`；都没有就用 `list_windows { app: <name> }` 找。
  - `get_window_state { pid, window_id, tree_format:"elements" }` → `elements[] { element_token, role, label, value, actions }`。
  - `scroll { pid, window_id?, direction:"down"|"up", by:"page", element_token? }`；网页滚动：`browser_pointer { target_id, tab_id, session, action:"scroll", delta_y:600 }`。
- 用户电脑（host）的浏览器工具只在档位 ≥「信任」时有（`o.browser`）；助理电脑（sandbox）的网页走 ext-browser，cua 浏览器工具是隐藏的，所以 **sandbox 只支持应用 / 窗口**。

## 2. 要新建 / 修改的文件（只动这些）
| 文件 | 做什么 |
|---|---|
| `packages/ext-computer/src/words.ts`（新，≤20 行） | 把 `index.ts` 里的 `SENSITIVE_WORDS` **挪**到这里（加 `取消|关闭|重置|退出|cancel|close|reset`，另起名 `GOAL_GUARD_WORDS`，见 §5.4），`index.ts` 改成从这里导入并照旧导出。**不许复制一份**。 |
| `packages/ext-computer/src/quick-io.ts`（新，≤150 行） | 两个循环共用的 I/O：`textOf`、`observe`（从 quick-steps-tool.ts 里**挪**过来）、`pageSummary`。 |
| `packages/ext-computer/src/quick-open.ts`（新，≤250 行） | `*_quick_open` 工具。 |
| `packages/ext-computer/src/quick-goal.ts`（新，纯逻辑，≤300 行） | 目标模式：候选动作生成、剪枝、问题构造、把选中的动作变成一步 `QuickStep`。不做 I/O。 |
| `packages/ext-computer/src/quick-goal-run.ts`（新，≤250 行） | 目标模式的执行循环。 |
| `packages/ext-computer/src/quick-steps.ts`（改） | `Observation` 加 `summary`；`parseObservation` 填 summary；`summarize` 末尾带上 summary；把 `similarity` / `normalize` 改成 `export`（目标模式要用，**不许另写一份**）。 |
| `packages/ext-computer/src/quick-steps-tool.ts`（改） | 用 `quick-io.ts` 的 `observe`；参数加 `goal` / `inputs` / `max_steps`，有 `goal` 时走 `runGoal`；注册 `*_quick_open`；提示词更新。 |
| `packages/ext-computer/src/index.ts`（改，**只许变短或持平**，现在 576 行） | `SENSITIVE_WORDS` 改从 `words.ts` 导入；导出新模块。 |
| `packages/server/test/quick-open.test.ts`、`quick-goal.test.ts`、`quick-goal-run.test.ts`（新） | 单测，见 §8。 |
| `packages/server/test/quick-steps.test.ts` / `quick-steps-tool.test.ts`（改） | summary 相关断言。 |
| `docs/MODULES.md` | 登记新文件。 |

服务端、界面**都不用改**（还是同一个「快速执行」开关和决策模型）。不许改 Pi / node_modules / 依赖。

## 3. 带回结果（先做这个，最简单）
### 3.1 `Observation.summary`（quick-steps.ts）
- 类型加 `summary: string`（必有，可以是空串）。
- `parseObservation`：
  - 网页：`structured.outline` 是字符串就用它；否则用 `content_refs` 每项 `role「name」` 一行。
  - 窗口：`elements` 每项一行 `role「label」${value ? `=${value}` : ""}`（跳过 label 和 value 都空的）。
  - 都截到 **2500 字**（超出加 `…（共 N 字）`）。
- `emptyObservation()` 的 summary 为 `""`。
- **fingerprint 不变**（不要把 summary 放进去）。

### 3.2 `summarize`
- 全部做完：在「全部 N 步做完…」后面加一段：`\n最后的页面内容（不用再读一遍）：\n${lastObs.summary}`。函数签名改成 `summarize(results, stopped?, lastObs?)`。
- 停下时：已经有元素列表，再加同样一段页面内容（用 `stopped.obs.summary`）。
- `quick-steps-tool.ts` 调用时把最后一次观察传进去（循环里的 `obs`）。

## 4. 打开工具 `*_quick_open`（quick-open.ts）
```ts
export interface QuickOpenOptions { prefix: string; target: "sandbox" | "host"; browser: boolean }
export function registerQuickOpen(pi: ExtensionAPI, o: QuickOpenOptions & { config: () => QuickStepsConfig | null }): void
```
- 名字：host 用 `hostpc_quick_open`，sandbox 用 `computer_quick_open`。和 quick_steps 一样：`o.config()` 为 null 就不注册；`annotations: { readOnlyHint:false, destructiveHint:false, openWorldHint:false }`（里面的每个动作照常过审批）。
- 参数（typebox）：
  - `url?: string`：打开网页（只有 `o.browser` 为真才出现在参数里）。只允许 `http:` / `https:` / `file:`，其他报错。
  - `browser?: "isolated" | "user"`：默认 `isolated`（独立的新 Chrome，不带用户登录状态）。`user` = 连用户正在用的 Chrome（要用户的登录状态时）。
  - `app?: string`：打开应用（名字或 bundle id，例如「计算器」「com.apple.calculator」）。
  - `session?: string`：默认 `quick-<6位随机>`。
  - `url` 和 `app` **必须恰好给一个**。
- 网页流程（每一步都用 `ctx.executeTool`，失败就抛错，错误信息带上那一步的名字和结果文本前 300 字）：
  1. `isolated`：`browser_prepare { allow_launch:true, profile:{mode:"isolated_new"}, session }`，取 `prepared_pid`。
     `user`：`list_windows { app:"Chrome", session }` 取 z_index 最大的窗口 → `browser_prepare { pid, window_id, session, strategy:{kind:"existing_profile"} }`；没有 Chrome 窗口就报错「没找到正在运行的 Chrome」。
  2. `list_windows { pid, session }`，最多试 10 次、每次间隔 300 毫秒，直到有窗口；取 z_index 最大的。
  3. `get_browser_state { pid, window_id, session }`：要求 `binding_quality === "exact"` 且 `mutation_allowed === true`，否则报错（原样带上结果里的 `hint` / `next_call`）。取 `target_id` 和 `tabs` 里 `active` 的那个（没有就第一个）的 `tab_id`。
  4. `browser_navigate { target_id, tab_id, session, url }`。
  5. `observe`（quick-io.ts）读一次 semantic_v2。
- 应用流程：
  1. `app` 里有 `.` 且没有空格 → 当 bundle_id，否则当 name：`launch_app { bundle_id | name, session }`。
  2. 进程号：按 §1 的顺序取；取不到就 `list_windows { app, session }`。然后 `list_windows { pid, session }` 最多 10 次、间隔 300 毫秒，取 z_index 最大的窗口。
  3. `observe` 读一次窗口（elements）。
- 返回文本（中文）：
  ```
  已打开：<网址或应用名>。
  target（传给 <quick_steps 工具名>）：<JSON.stringify(target)>
  可操作的元素（前 40 个）：<handle role「name」 每行一个>
  页面内容：<summary>
  ```
  `details: { target, session }`。
- 工具说明（description）写清楚：先用它打开，再用 quick_steps；`url` 默认开独立 Chrome；要用户登录状态才用 `browser:"user"`。

## 5. 目标模式（quick-goal.ts 纯逻辑 + quick-goal-run.ts 循环）
### 5.1 参数（在 `*_quick_steps` 上加，和 `steps` 二选一）
- `goal: string`：要达到的结果，用户能看懂的一句话，例如「把表单填好并提交」。
- `inputs: { name: string; value?: string; files?: string[] }[]`：要用到的值（0–20 个）。`name` 写这个值的意思（「名称」「分辨率」「参考图片」），`value` 是要填 / 要选的内容，`files` 是要上传的文件。**这是目标模式里唯一的值来源。**
- `max_steps?: number`：默认 15，最大 30。
- 校验：`steps` 和 `goal` 恰好给一个；每个 input 要有 `value` 或 `files`。

### 5.2 候选动作 `goalActions(obs, inputs, pending, goal): GoalAction[]`
```ts
export type GoalActionKind = "fill" | "select" | "upload" | "click" | "check" | "scroll" | "finish" | "reobserve" | "abstain";
export interface GoalAction { id: string /* a1… */; kind: GoalActionKind; candidate?: Candidate; input?: number /* inputs 下标 */; desc: string }
```
- `pending` = 还没完成的 input 下标集合。
- 对 `obs.candidates` 里每个元素，按 role / actions（复用 quick-steps.ts 的 `filterByKind` 用到的角色表：把 `KIND_ROLES` 和 `roleKey` 改成 `export`，**不许另写一份**）：
  - 输入框类（`type` 那组角色，或 `actions` 含 `type`）：对每个 pending 的、有 `value` 的 input → `fill`，desc `在${role}「${name}」里填「${input.name}」的值`。
  - 下拉类（`select` 那组角色）：对每个 pending 的、有 `value` 的 input → `select`，desc `在「${name}」里选「${input.value}」`。
  - 上传类（`upload` 判断同 `filterByKind`）：对每个 pending 的、有 `files` 的 input → `upload`，desc `把「${input.name}」的 ${n} 个文件传到「${name}」`。
  - 勾选类（`check` 那组）→ `check`，desc `勾选 / 取消「${name}」（当前：${value || "未知"}）`。
  - 点击类（`click` 那组或 `actions` 含 `click` / `press`，且不是上面几类）→ `click`，desc `点击${role}「${name}」`。
- **剪枝**（候选太多 Jev 会糊涂，也慢）：
  1. 每个 (元素, input) 组合只给 `similarity(input.name, 元素名)` 最高的 **2 个 input**。
  2. 所有动作按分数排序取前 **28 个**：分数 = `max(similarity(goal, 元素名), similarity(input.name, 元素名))`；分数相同保持原顺序。
- **危险按钮守门**（§5.4）：`click` / `check` 的元素名命中 `GOAL_GUARD_WORDS`，而 `goal` 里没有出现这个词（同一个匹配到的子串）→ 不列入。
- 最后固定加 4 个：`scroll`（「往下滚动看更多」）、`finish`（「目标已经完成」）、`reobserve`（「页面还没准备好，等一下再看」）、`abstain`（「拿不准，交回大模型」）。
- 编号 `a1…aN` 按最终顺序。

### 5.3 问题 `buildGoalContext(goal, inputs, pending, done, obs, actions, withImage)`
- `state`：`{ 目标, 要用的值: inputs.map((x,i)=>({ 名字:x.name, 值:x.value ?? `${x.files?.length} 个文件`, 状态: pending.has(i) ? "还没用" : "已用过" })), 已经做了: done.slice(-8), 页面: { 标题, 地址, 内容: obs.summary.slice(0,1500) } }`。
  - 注意：这里**可以**写 value（Jev 要靠它判断下拉选哪个、填哪个框），但 Jev 只选编号，执行时值仍然只从 inputs 取。
- `images`：同第一版（有截图且模型能看图才带）。
- `questions.next`：`{ type:"choice", instructions: GOAL_INSTRUCTIONS, criteria: Object.fromEntries(actions.map(a=>[a.id, a.desc])) }`。
- `GOAL_INSTRUCTIONS`（原样用）：「这是电脑操作里的一步。根据目标、要用的值、已经做了的步骤和当前页面，从候选动作里挑出**下一步**最该做的那一个。要用的值都用上、目标里要求的操作都做了，才选 finish。页面还没加载好选 reobserve；要找的东西可能在下面选 scroll；拿不准、或者候选里没有该做的动作，选 abstain。」

### 5.4 危险按钮守门 `GOAL_GUARD_WORDS`（words.ts）
- `SENSITIVE_WORDS` 原样挪过来（index.ts 改为导入）。
- `export const GOAL_GUARD_WORDS = new RegExp(`${SENSITIVE_WORDS.source}|取消|关闭|重置|退出|cancel|close|reset`, "i")`。
- 判断函数 `export function guardedOut(name: string, goal: string): boolean`：`name` 里匹配到的每个词都要在 `goal` 里出现（不分大小写），否则返回 true（= 不列入）。

### 5.5 选中动作 → 一步 `actionToStep(a, inputs): QuickStep | null`
- `fill` → `{ do:"type", what:a.candidate.name, value: inputs[a.input].value }`；`select` → `{ do:"select", … value }`；`upload` → `{ do:"upload", what, files }`；`click` → `{ do:"click", what }`；`check` → `{ do:"check", what }`；其他返回 null。
- 执行时直接用第一版的 `buildCall(step, a.candidate, target, prefix)`（已经是挑好的元素，不再问一次 Jev）。

### 5.6 执行循环 `runGoal(ctx, o, target, params, model, imageOk, signal)`（quick-goal-run.ts）
```
obs = observe(imageOk)
pending = 所有 input 下标; done = []; seen = Map<fingerprint, 次数>; results = []
for step = 1..max_steps:
  若 signal 中止 → 停「已中断」
  seen[obs.fingerprint]++，>3 → 停「页面一直没变化，可能卡住了」
  actions = goalActions(obs, inputs, pending, goal)
  res = classify(model, buildGoalContext(...), {signal})；带图出错 → 不带图再问一次；还错 → 停「决策模型出错：…」
  选中 a = answers.next.choice；概率 p = probabilities[a]（没有就 confidence）
  a 不在 actions 里 → 停；abstain → 停「决策模型拿不准」；p < 0.6 → 停「把握不够（p，最高的 3 个候选）」
  reobserve → 等 800 毫秒、obs = observe(imageOk)、continue（连续两次 reobserve → 停）
  scroll → 网页 browser_pointer {target_id, tab_id, session, action:"scroll", delta_y:600}；窗口 scroll {pid, window_id, direction:"down", by:"page"}；obs = observe(imageOk)；done.push("往下滚动"); continue
  finish → 结束（成功），说明「决策模型认为目标已完成，请你核对下面的页面内容」
  其他：step = actionToStep(a)；call = buildCall(step, a.candidate, target, prefix)；
       out = executeTool(call)；isError → 停（原样原因 + 「不要换方式重试被拒绝的动作」）
       after = observe(false)；v = verifyStep(step, a.candidate, obs, after)（点击类没变化多等 600 毫秒再判一次，同第一版）
       v 失败 → 停（原因）
       成功：fill/select/upload → pending.delete(a.input)；done.push(a.desc)；results 记一行；obs = after（要截图时下一轮再读带图的，同第一版的规则）
max_steps 用完 → 停「步数用完了」
```
- 返回：每步一行（第几步、做了什么、概率、核对说明、毫秒），结尾：成功 / 停下原因 + 还没用上的值 + `最后的页面内容（不用再读一遍）：<summary>`。停下也**不设 isError**。
- `details: { mode:"goal", steps, stopped, pending: [...pending] }`。

## 6. 提示词（quick-steps-tool.ts 的 `quickStepsPrompt` 整段换成）
```
<quick-steps>
电脑操作尽量少来回：
1. 打开网页或应用先用 ${open}（给 url 或 app，一次就打开、绑定好并返回 target 和页面内容）。
2. 已经确定的几步（填表、选下拉、勾选、上传、逐个点）用 ${steps} 的 steps 一次交出去。
3. 知道要达到什么、要用哪些值，但不清楚页面具体长什么样：用 ${steps} 的 goal + inputs，让决策模型自己一步步做。值只能来自 inputs；要提交 / 发送 / 删除之类的操作，goal 里要明确写出来。
4. 它们返回的结果里已经带了最后的页面内容，不用再读一遍；停下时按原因和元素列表用普通工具接着做，被拒绝的动作不要换方式重试。
每个动作照常按用户的权限档位审批。
</quick-steps>
```
（`${open}` / `${steps}` 是这个 target 下两个工具的真实名字。只注册一次提示词，不要两个工具各加一遍。）

## 7. 注册（index.ts / quick-steps-tool.ts）
- `registerQuickSteps` 里一起注册 `*_quick_open`（同一个 config 判断，同一个 `before_agent_start` 提示词）。`index.ts` 不用多加调用。
- `index.ts` 只改 import / export，行数不能变多。

## 8. 单测（在 `packages/server` 下跑：`node --import tsx --import ./test/setup.ts --test test/quick-*.test.ts`）
`quick-steps.test.ts`（补）：
1. 网页 `outline` → summary；没有 outline 用 content_refs；窗口 elements → summary；超过 2500 字截断。
2. `summarize` 做完 / 停下都带「最后的页面内容」。

`quick-goal.test.ts`：
1. 表单（名称 textbox、分辨率 combobox、参考图片 file、高清 checkbox、提交 / 取消 button）+ inputs（名称、分辨率、参考图片）：生成 fill / select / upload / check / click，最后 4 个固定动作都在。
2. 每个元素最多 2 个 input；超过 28 个只留 28 个（加固定 4 个）。
3. 危险按钮：goal「把表单填好」时没有「提交」「取消」；goal「填好并提交」时有「提交」没有「取消」。
4. 已经用过的 input（不在 pending）不再生成 fill / select / upload。
5. `buildGoalContext`：state 有目标 / 要用的值（含状态）/ 已经做了 / 页面内容；criteria 和 actions 一一对应；withImage 才带图。
6. `actionToStep`：每种 kind 的值都只来自 inputs；scroll / finish / reobserve / abstain 返回 null。
7. `guardedOut`：「删除文件」在 goal「删除旧文件」里不拦，在 goal「整理文件」里拦。

`quick-goal-run.test.ts`（假 executeTool + 假 classify，照 quick-steps-tool.test.ts 的写法）：
1. 表单：Jev 依次选 填名称 → 选分辨率 → 上传 → 点提交 → finish；断言调用顺序、`browser_type.text` 等于 inputs 的 value、结果有「最后的页面内容」。
2. abstain → 停下，结果里有还没用上的值。
3. 概率 < 0.6 → 停下，不执行动作。
4. 动作 isError（审批被拒）→ 停下，后面不再调用动作。
5. 同一页面指纹出现超过 3 次 → 停下「页面一直没变化」。
6. max_steps 用完 → 停下。
7. 连续两次 reobserve → 停下。
8. scroll：网页调 `browser_pointer`、窗口调 `scroll`。

`quick-open.test.ts`：
1. 网页 isolated：调用顺序 browser_prepare → list_windows → get_browser_state(绑定) → browser_navigate → get_browser_state(semantic_v2)；返回里有 target JSON 和页面内容。
2. 绑定不是 exact → 报错，带 hint。
3. 应用：launch_app（name / bundle_id 两种）→ list_windows → get_window_state；launch_app 没返回 pid 时用 `list_windows {app}` 找。
4. url 和 app 都给 / 都不给 → 报错；sandbox 或没有浏览器工具时参数里没有 url。
5. `config()` 为 null 不注册。

## 9. 交付前必须做
1. `npm run check`（仓库根目录）全部通过。
2. `wc -l`：新文件不超过上面写的行数；`index.ts` ≤ 576。
3. `docs/MODULES.md` 登记新文件（每个一行）。
4. **不要** commit、push、打 tag。改完就停。不要跑 e2e，不要操作电脑。
5. 用中文汇报：改了哪些文件（每个一句）、复用了什么、单测和 `npm run check` 的结果（贴最后几行）、哪些地方你不确定。
