状态：已批准（实现方案，2026-11-04；总设计见 [fast-executor.md](fast-executor.md)）

# 快速执行者：实现方案（给写代码的助理）

> 先通读：`AGENTS.md`（项目规则）、`docs/MODULES.md`、`docs/design/fast-executor.md`（为什么做、整体做法）。
> 本文件把每个文件、每个函数、每个判断都写死了，**照着做，不要自己改设计**。哪里写得不清楚，停下来问，不要猜。

## 0. 一句话
新工具 `computer_quick_steps`：大模型一次写好几步（「名称框填 X → 下拉选 2K → 点提交」），工具自己循环：
读一次页面结构 → 列候选元素 → 问决策模型（Jev，Pi 的 classifier）选哪个 → 用 cua 执行 → 再读一次核对。
**要填的值只来自大模型写的 `value`，Jev 只挑元素编号。**

## 1. 已经确认的事实（不用再查）
- Pi 1.5.0 的工具 `execute(id, params, signal, onUpdate, ctx)` 第 5 个参数 `ctx` 是 `ExtensionToolContext`：
  - `ctx.executeTool(name, args, { signal })` 调用别的工具，**走同一套 `tool_call` 钩子**（我们 ext-computer 里的暂停 / 档位 / 受保护动作 / 敏感动作审批全部自动生效，审批卡照常弹出）。返回 `AgentToolCallOutcome`：`{ result: { content, structuredContent?, details }, isError, durationMs? }`，失败（被拦、被拒、报错）都是 `isError: true`，不会 throw。
  - `ctx.modelRegistry.classify(model, context, { signal })` 调分类模型，不 throw，看 `stopReason`（`"stop" | "error" | "aborted"`）和 `errorMessage`。
  - `ctx.modelRegistry.findOfType("classifier", provider, id)` 拿模型对象，`model.input` 含 `"image"` 才能传图。
  - 类型在 `node_modules/@earendil-works/pi-ai/dist/types.d.ts`（`ClassifierContext` 第 480 行起）和 `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`（`ExtensionToolContext` 第 281 行起）。先读这两处再写。
- 分类请求格式：
  ```ts
  { state: JsonObject, images?: ImageContent[], questions: { pick: { type: "choice", instructions: string, criteria: Record<string,string> } } }
  // 结果 answers.pick = { type:"choice", choice: "c3", probabilities: { c1: 0.02, c3: 0.91, ... }, confidence }
  ```
- cua 工具（MCP 工具名前缀：用户电脑 `mcp__hostpc__`，助理电脑 `mcp__computer__`，见 `ext-computer/src/index.ts` 的 `HOST_MCP_PREFIX` / `MCP_PREFIX`）：
  - 读网页：`get_browser_state { target_id, tab_id, session, snapshot_format:"semantic_v2", include_screenshot? }`，元素 ref 形如 `p<快照>:<序号>`，新快照后旧 ref 失效。
  - 网页动作：`browser_click { target_id, tab_id, session, ref }`、`browser_type { …, ref, text, replace:true }`、`browser_select { …, ref, label }`、`browser_set_input_files { …, ref, files }`。
  - 读窗口：`get_window_state { pid, window_id, tree_format:"elements", include_screenshot? }`，`structuredContent.elements[]` 每项有 `element_index, element_token, role, label, value, actions`。`element_token` 形如 `s0000002a:11`。
  - 窗口动作：`click { pid, window_id, element_token }`、`set_value { pid, window_id, element_token, value }`、`press_key { pid, window_id, key }`。
  - MCP 结果的 `structuredContent` 外面包了一层，用现成的 `unwrapStructured()`（`ext-computer/src/structured.ts`）解开。
- **网页结果的确切字段名我们还没在真机上看过。** 所以解析写成「宽松 + 有单测」：见 §3.2。真机验证由审查的人做。
- 助理电脑（sandbox）里的网页走 ext-browser（Playwright），cua 浏览器工具是隐藏的，所以 **sandbox 只支持 `window` 目标**；用户电脑（host）两种都支持，但「限定」档位没有浏览器工具（`host.browserTools === false` 时不支持 `browser` 目标）。

## 2. 要新建 / 修改的文件（只动这些）
| 文件 | 做什么 |
|---|---|
| `packages/ext-computer/src/quick-steps.ts`（新，纯逻辑，≤400 行） | 类型、候选解析、过滤排序、问题构造、判断、拼 cua 调用、核对。**不做任何 I/O**。 |
| `packages/ext-computer/src/quick-steps-tool.ts`（新，≤300 行） | `registerQuickSteps(pi, opts)`：注册工具 + 提示词，执行循环（调 `ctx.executeTool` / `ctx.modelRegistry.classify`）。 |
| `packages/ext-computer/src/index.ts`（改，**最多加 10 行**，它已经 569 行，上限 600） | `ComputerHost` 加一个可选字段 `quickSteps`；`computerExtension` 里调 `registerQuickSteps`；`export` 新模块。 |
| `packages/server/src/fast-executor.ts`（新，≤150 行） | 设置读写 + 选模型。 |
| `packages/server/src/routes/fast-executor.ts`（新，≤80 行） | `GET /api/fast-executor`、`PUT /api/fast-executor`。在 `http.ts` 里照其他路由的写法挂上。 |
| `packages/server/src/agent-runtime/extensions.ts`（改，几行） | 两处 `computerExtension({...})` 都加 `quickSteps: () => fastExecutorFor()`。 |
| `apps/web/src/components/FastExecutorSetting.tsx`（新，≤150 行） | 设置界面。 |
| `apps/web/src/components/HostControl.tsx`（改，≤3 行） | 在 `HostControlSettings` 里放 `<FastExecutorSetting />`。 |
| `packages/server/test/quick-steps.test.ts`（新） | 纯逻辑单测。 |
| `packages/server/test/quick-steps-tool.test.ts`（新） | 执行循环单测（假 executeTool + 假 classify）。 |
| `docs/MODULES.md` | 登记新文件（每个一行，照现有格式）。 |

不许改：Pi / Hindsight / `node_modules` / 依赖版本 / 其他无关文件。不许加新依赖。

## 3. `quick-steps.ts`（纯逻辑）

### 3.1 类型
```ts
export type StepKind = "click" | "type" | "select" | "check" | "press" | "upload";
export interface QuickStep { do: StepKind; what: string; value?: string; files?: string[]; key?: string }
export type QuickTarget =
  | { kind: "browser"; tab_id: string; target_id?: string; session?: string }
  | { kind: "window"; pid: number; window_id: number };
export interface Candidate { id: string /* c1,c2… */; handle: string /* 网页 ref 或窗口 element_token */; role: string; name: string; value?: string; actions?: string[] }
export interface Observation { candidates: Candidate[]; title?: string; url?: string; fingerprint: string; screenshot?: { data: string; mimeType: string } }
export type Decision = { kind: "pick"; candidate: Candidate; probability: number } | { kind: "reobserve" } | { kind: "stop"; reason: string };
export const MAX_STEPS = 20;
export const MAX_CANDIDATES = 24;
export const MIN_PROBABILITY = 0.6;
```

### 3.2 解析候选：`parseObservation(target: QuickTarget, structured: unknown, text: string, content: {type:string; data?:string; mimeType?:string}[]): Observation`
- `structured` 是 `unwrapStructured(outcome.result.structuredContent)` 的结果（可能是 null）。
- **窗口**：读 `structured.elements`（数组）。每项：`handle = element_token`，`role`，`name = label ?? title ?? ""`，`value`（转字符串），`actions`（字符串数组）。没有 `element_token` 的跳过。
- **网页**（字段名未在真机确认，按顺序尝试，找到第一个非空的就用）：
  1. `structured.refs`、`structured.actions`、`structured.elements`、`structured.action_refs` 里是数组的那个；每项取 `handle = ref ?? id`、`role ?? type ?? kind`、`name ?? label ?? text ?? accessible_name`、`value`、`actions`（数组或字符串）。`handle` 必须匹配 `/^p[^:\s]+:\d+$/`，否则跳过。
  2. 都没有时，退回解析 `text`：每行用正则 `/\b(p[\w-]+:\d+)\b/` 找 ref，该行去掉 ref 后剩下的文字里，第一个单词当 role（例如 `button`、`textbox`），引号 `"…"` 或 `「…」` 里的当 name，没有引号就用剩下的整行（截到 80 字）。
  - `title` / `url`：`structured.title`、`structured.url`，或 `structured.page?.title` / `structured.page?.url`。
- 去重：同一个 `handle` 只留第一个。编号 `c1…cN` 按出现顺序。
- `fingerprint`：`url + "|" + title + "|" + candidates.map(c => role+name+(value??"")).join("\u0001")` 的简单哈希（自己写 32 位 FNV-1a，不引依赖）。注意：**不要**把 handle 放进 fingerprint（每次快照 ref 都变）。
- `screenshot`：`content` 里第一个 `type === "image"` 的块。

### 3.3 过滤：`filterByKind(kind: StepKind, list: Candidate[]): Candidate[]`
- role 统一小写后匹配（中英都写上，cua 的 macOS role 可能是 `AXButton` 这种，先去掉 `ax` 前缀再比）：
  - `type`：`textbox | searchbox | textarea | textfield | text field | combobox | spinbutton | input`
  - `select`：`combobox | listbox | popupbutton | popup button | select | menubutton`
  - `check`：`checkbox | radio | radiobutton | switch | toggle`
  - `upload`：`actions` 里含 `upload`，或 role 含 `file`
  - `click`：`button | link | menuitem | tab | option | checkbox | radio | switch | cell | row | listitem | image`，或 `actions` 含 `click` / `press`
  - `press`：不需要候选，返回空数组。
- 过滤后为空：返回原列表（让 Jev 去判断，它可以选「拿不准」）。

### 3.4 排序：`rankCandidates(what: string, list: Candidate[], limit = MAX_CANDIDATES): Candidate[]`
- 相似度 = 字符二元组（中文逐字 bigram，英文按小写单词）的 Dice 系数：`what` 对 `name + " " + (value ?? "")`。
- 稳定排序，相似度高的在前；取前 `limit` 个；**保持原 id 不变**。

### 3.5 直接命中：`exactMatch(what: string, list: Candidate[]): Candidate | null`
- 过滤后的列表里，`normalize(name) === normalize(what)` 的**恰好只有一个** → 返回它（不用问 Jev，省一次请求）。`normalize` = 去空白、去标点、小写。

### 3.6 构造问题：`buildClassifierContext(step, index, total, done: string[], obs: Observation, list: Candidate[], withImage: boolean)`
- `state`：
  ```ts
  { 任务: `第 ${index+1}/${total} 步：${describeStep(step)}`, 已完成: done.slice(-5), 页面: { 标题: obs.title, 地址: obs.url }, 候选: Object.fromEntries(list.map(c => [c.id, describeCandidate(c)])) }
  ```
  - `describeStep`：`点击「what」` / `在「what」里填写`（**不要把 value 写进 state**，Jev 不需要知道要填什么；select 例外，写 `在「what」里选择「value」`，因为要靠选项判断是不是对的下拉）/ `勾选「what」` / `上传文件到「what」`。
  - `describeCandidate`：`${role}「${name}」${value ? `（当前值：${value.slice(0,40)}）` : ""}`。
- `images`：`withImage && obs.screenshot ? [{ type:"image", data, mimeType }] : undefined`。
- `questions.pick`：
  ```ts
  { type: "choice",
    instructions: "这是电脑操作里的一步。从候选元素里挑出这一步要操作的那一个。只根据元素的角色、名字、当前值（和截图，如果有）判断。没有合适的、或者有两个以上都可能，就选 abstain；页面看起来还没加载完、要操作的元素可能马上出现，就选 reobserve。",
    criteria: { ...候选（同上 describeCandidate）, reobserve: "页面还没准备好，等一下再看一次", abstain: "拿不准，或者候选里没有要找的元素" } }
  ```

### 3.7 判断：`decide(answer: unknown, list: Candidate[], reobserved: boolean): Decision`
- `answer` 不是 `{type:"choice", choice}` → `stop("决策模型没有给出选择")`。
- `choice === "abstain"` → `stop("决策模型拿不准")`。
- `choice === "reobserve"` → 已经重读过一次（`reobserved`）就 `stop("页面一直没准备好")`，否则 `{kind:"reobserve"}`。
- 概率 `p = probabilities[choice] ?? confidence ?? 0`；`p < MIN_PROBABILITY` → `stop("决策模型把握不够（最高 ${p.toFixed(2)}）")`，原因里附上概率最高的 3 个候选的描述。
- 否则 `pick`。

### 3.8 拼调用：`buildCall(step, c: Candidate | null, target, prefix): { tool: string; args: Record<string, unknown> } | { error: string }`
- 网页（`target.kind === "browser"`），公共参数 `base = { tab_id, target_id?, session? }`（只放有值的）：
  - `click` / `check` → `browser_click { ...base, ref: c.handle }`
  - `type` → `browser_type { ...base, ref, text: step.value ?? "", replace: true }`
  - `select` → `browser_select { ...base, ref, label: step.value ?? "" }`
  - `upload` → `browser_set_input_files { ...base, ref, files: step.files ?? [] }`
  - `press` → `{ error: "网页里按键这一步请用普通工具做" }`
- 窗口：公共 `base = { pid, window_id }`：
  - `click` / `check` → `click { ...base, element_token: c.handle }`
  - `type` / `select` → `set_value { ...base, element_token, value: step.value ?? "" }`
  - `press` → `press_key { ...base, key: step.key ?? step.value ?? "" }`（`c` 为 null）
  - `upload` → `{ error: "窗口里上传文件请用普通工具做" }`
- `tool` 要加 `prefix`（`mcp__hostpc__` 或 `mcp__computer__`）。
- 参数校验（返回 `{error}`）：`type`/`select` 没有 `value`；`upload` 没有 `files`；`press` 没有 `key`/`value`。

### 3.9 核对：`verifyStep(step, picked: Candidate | null, before: Observation, after: Observation): { ok: true; note: string } | { ok: false; reason: string }`
- `type` / `select`：在 `after` 里找 role 相同、name 相同的候选（ref 变了，按名字找）；找到且 `normalize(value)` 包含 `normalize(step.value)` → ok「值已是「…」」；找到但值不对 → `fail("填了但值没变（现在是「…」）")`；找不到 → ok「页面变了，没找到原来的输入框，交给后面的步骤」（不算失败）。
- `click` / `check` / `press` / `upload`：`after.fingerprint !== before.fingerprint` → ok「页面有变化」；相同 → `fail("点了但页面没有变化")`（执行循环里会先多等一次再判，见 §4）。

### 3.10 汇总：`summarize(results, stopped?: { index; reason; obs })`
- 每步一行：`${i}. ${describeStep} → 选了 ${describeCandidate}（${handle}），概率 ${p}${直接命中 ? "（名字完全对上，没问决策模型）" : ""}，${核对说明}，${ms} 毫秒`。
- 停下时最后加：`第 ${i} 步停下：${reason}。后面的步骤没做。当前页面可操作的元素（前 30 个）：` + 列表（`handle role「name」`），方便大模型用普通工具接着做。
- 全部做完：`全部 ${n} 步做完，共 ${总毫秒} 毫秒。`

## 4. `quick-steps-tool.ts`（执行循环）
```ts
export interface QuickStepsConfig { provider: string; id: string; images: boolean }
export interface QuickStepsOptions { prefix: string; target: "sandbox" | "host"; browser: boolean /* 是否支持 browser 目标 */; config: () => QuickStepsConfig | null }
export const QUICK_STEPS_PROMPT = `<quick-steps>…</quick-steps>`; // 见下
export function registerQuickSteps(pi: ExtensionAPI, o: QuickStepsOptions): void
```
- **只在 `o.config()` 不为 null 时注册**（注册时求值一次）；每次执行时再求值一次，为 null 就返回错误「快速执行已关闭」。
- 工具名：`computer_quick_steps`（sandbox 和 host 同时挂时会重名——host 用 `hostpc_quick_steps`，sandbox 用 `computer_quick_steps`，按 `o.target` 选）。
- `parameters`（typebox，照 index.ts 里 `Type.Object` 的写法）：`target`（`Type.Union` 两种，见 §3.1；sandbox 或 `!o.browser` 时只允许 window）、`steps`（数组，1–20 项）、`stop_if`（可选字符串）。`description` 写清楚：什么时候用、每种 `do` 的意思、值只用 `value`、会照常走审批。
- `promptSnippet`：`computer_quick_steps: 已经想好的连续几步（填表、选择、逐个点）一次交出去，快速执行`。
- 系统提示：在 `before_agent_start` 里追加 `QUICK_STEPS_PROMPT`（写法照 index.ts 里 `pi.on("before_agent_start", …)`）。内容（中文，≤6 行）：已经确定的连续几步（填表、选下拉、上传、逐个点按钮）用这个工具一次交出去，比一步一步调普通工具快得多；`what` 写屏幕上看得到的名字；拿不准的一步、要看画面判断的一步、打开网址 / 切标签页，还是用普通工具；它停下时按返回的原因和元素列表接着用普通工具做。
- `execute(_id, params, signal, _onUpdate, ctx)`：
  1. 校验：`steps.length` 1–20；target 合法；每步先过 `buildCall` 的参数校验（用一个假候选），有错直接返回错误，不开始执行。
  2. `model = ctx.modelRegistry.findOfType("classifier", cfg.provider, cfg.id)`；没有 → 返回错误「决策模型不可用」。`withImage = cfg.images && model.input?.includes("image")`。
  3. `observe(withShot)`：调 `get_browser_state` / `get_window_state`（参数见 §1，`include_screenshot: withShot`），`isError` → 停下（原因 = 结果文本前 300 字）；否则 `parseObservation`。
  4. 循环每一步 `i`：
     - `obs` = 上一步核对时读到的（第一步先 `observe(withImage)`）；如果这一步需要问 Jev、`withImage` 为真、而 `obs` 没有截图，就重新 `observe(true)`。
     - `press`：不挑元素，直接 `buildCall(step, null, …)`。
     - 其他：`list = rankCandidates(step.what, filterByKind(step.do, obs.candidates))`；`list` 为空 → 停下「页面上没有可操作的元素」。`exactMatch` 命中就直接用；否则 `classify`：
       - `stopReason === "error"` 且带了图 → 去掉图再问一次；还是错 → 停下「决策模型出错：…」。`aborted` → 停下「已中断」。
       - `decide`：`reobserve` → 等 800 毫秒、`observe(withImage)`、同一步重来（只一次）；`stop` → 停下。
     - `executeTool(call.tool, call.args, { signal })`；`isError` → 停下，原因 = 结果文本前 300 字（被审批拒绝、受保护动作没批准、暂停，都会走到这里；原样告诉大模型，并加一句「不要换方式重试被拒绝的动作」）。
     - 核对：`after = observe(false)`；`verifyStep`；点击类没变化 → 等 600 毫秒再 `observe(false)` 判一次；还失败 → 停下。成功 → `obs = after`，记一行结果。
     - 每步之间检查 `signal.aborted`。
  5. 返回 `{ content: [{ type:"text", text: summarize(...) }], details: { steps: 结果数组, stopped } }`。停下时**不要**设 `isError`（这是正常交回，不是工具坏了）；参数错误 / 模型不可用才 `throw new Error(…)`。
- 用 `ctx.executeTool` 调的 cua 工具名必须带前缀，并且要在当前会话里可用；不要自己连 MCP、不要自己 spawn cua。

## 5. `index.ts` 的改动（≤10 行）
- `ComputerHost` 加：`/** 快速执行者（computer_quick_steps）的决策模型；返回 null = 不提供。每次调用求值 */ quickSteps?: () => QuickStepsConfig | null;`
- `computerExtension` 里、`pi.on("tool_call", …)` 之前加：
  ```ts
  if (host.quickSteps && policy() !== "observe") registerQuickSteps(pi, { prefix, target: host.target, browser: host_ && browserOn, config: host.quickSteps });
  ```
- 文件顶部 `export { registerQuickSteps, QUICK_STEPS_PROMPT, type QuickStepsConfig } from "./quick-steps-tool.ts";` 和 `export * from "./quick-steps.ts";`（或只导出单测要用的）。
- 改完 `wc -l` 必须 ≤600。

## 6. 服务端设置
`packages/server/src/fast-executor.ts`：
```ts
export interface FastExecutorSettings { enabled: boolean; provider: string | null; id: string | null; images: boolean }
const KEY = "fastExecutor"; const DEFAULTS = { enabled: true, provider: null, id: null, images: true };
export function fastExecutorSettings(): FastExecutorSettings   // getSetting(KEY, DEFAULTS) 合并默认值
export function saveFastExecutorSettings(p: Partial<FastExecutorSettings>): FastExecutorSettings  // 校验类型后 setSetting
export function availableClassifiers(): { provider: string; id: string; name: string; image: boolean }[]  // 已配置凭据的分类模型
export function fastExecutorFor(): QuickStepsConfig | null
```
- 设置读写用 `db.ts` 的 `getSetting` / `setSetting`。
- `availableClassifiers`：**复用**现有的模型目录（`model-registry.ts` 里带 `capabilities: ["classifier"]` 的那套，和设置 › 模型页同一个来源），只取「已配置」的。先 `rg "classifier" packages/server/src/model-registry.ts packages/server/src/routes` 找到现成的函数，不要另写一份列模型的逻辑。`image` = 模型 `input` 含 `"image"`。
- `fastExecutorFor()`：`!enabled` → null；设了 provider/id 且在 `availableClassifiers()` 里 → 用它；否则自动选：第一个 id 含 `jev` 的，没有就第一个；一个都没有 → null。返回 `{ provider, id, images }`。
- 路由 `routes/fast-executor.ts`：`GET /api/fast-executor` → `{ settings, models: availableClassifiers(), effective: fastExecutorFor() }`；`PUT /api/fast-executor`（加 `localOnly`，照 `routes/host-control.ts` 的写法）→ 保存并返回同样结构。挂到 `http.ts`。
- `extensions.ts`：`sandboxComputer()` 和 host 的 `computerExtension({...})` 都加 `quickSteps: () => fastExecutorFor(),`。

## 7. 界面 `FastExecutorSetting.tsx`
照 `docs/design/ui-standard.md`：名称 + 一行大白话 + 「?」。只用 `ui.tsx` 里的现成组件（`<Help>`、`<Fold>`、`<Select>`、开关用设置页现有的那种，先在 `HostControl.tsx` / `Settings.tsx` 里找现成写法照抄）。
- 标题：**快速执行**
- 一行说明：已经想好的几步（填表、选下拉、逐个点）交给决策模型一步步挑元素执行，比每一步都等大模型想快很多。
- `<Help>`：大模型先把几步写好，决策模型（如 TypeSafe 的 Jev）每一步只从页面上真实存在的元素里挑一个，要填的内容只用大模型写的；拿不准就停下交回大模型。每个动作照常按你给的权限档位审批。决策模型按次计费，很便宜。
- 开关：开 / 关（`enabled`）。
- 决策模型：`<Select>`，第一项「自动（推荐）」= provider/id 都为 null，后面是 `models`。下面一行小字显示现在实际用的是哪个（`effective`）。
- `models` 为空：不显示下拉，显示一行「还没有可用的决策模型。在 设置 › 模型 里添加带分类器的服务（例如 TypeSafe 的 Jev）后就能用。」
- `<Fold title="高级">` 里：「带截图给决策模型」开关（`images`），说明「能帮它分清长得像的按钮；模型不支持看图时自动不带。」
- 状态：一个加载状态 + 一个保存错误（照硬规则 1）。每项改了立即保存（`PUT`），用 `latest-write.ts` 串行保存。
- 在 `HostControlSettings` 里合适的位置（权限档位那块下面）放 `<FastExecutorSetting />`。加 `data-testid="fast-executor"`、`"fast-executor-toggle"`、`"fast-executor-model"`。

## 8. 单测（`node --import tsx --import ./test/setup.ts --test test/quick-steps*.test.ts`，在 `packages/server` 下跑）
`quick-steps.test.ts`（纯函数）：
1. 窗口 `elements` 解析：token / role / label / value；没 token 的跳过。
2. 网页：`refs` 数组形式、`elements` 数组形式、只有文本的形式，三种都能解析出 ref 和名字；非法 ref 跳过；重复去重。
3. fingerprint：ref 变了但内容一样 → 相同；值变了 → 不同。
4. `filterByKind`：type 只留输入框、select 只留下拉、过滤为空时返回原列表、`AXButton` 能认成 button。
5. `rankCandidates`：「名称」排在「名称说明」「提交」前面；超过 24 个只留 24 个；id 不变。
6. `exactMatch`：唯一完全一致才命中；两个同名不命中。
7. `buildClassifierContext`：type 步骤的 state 里**没有** value；select 有；criteria 含 reobserve / abstain；withImage 才带 images。
8. `decide`：abstain → stop；reobserve 第一次 / 第二次；概率 0.59 → stop、0.6 → pick；乱的 answer → stop。
9. `buildCall`：每种 do × 两种 target 的工具名和参数（带前缀）；`value` 只来自 step；缺 value / files / key 报错；网页 press、窗口 upload 报错。
10. `verifyStep`：值对上 ok、值不对 fail、找不到 ok、点击有变化 ok、没变化 fail。

`quick-steps-tool.test.ts`（照 `packages/server/test` 里其他扩展测试的写法造一个假的 `pi`，收集 `registerTool` 注册的工具，直接调它的 `execute`，传假 `ctx`）：
1. `config()` 返回 null 时不注册工具。
2. 三步表单（填名称 → 选下拉 → 点提交）全部成功：假 `executeTool` 按调用次序返回假的观察结果，假 `classify` 返回高概率；断言调用顺序、`browser_type` 的 text 等于 step.value、结果文字里有「全部 3 步做完」。
3. 名字完全一致时不调用 classify。
4. 带图失败 → 不带图重试一次。
5. `executeTool` 返回 `isError`（模拟审批被拒）→ 在这一步停下，结果里有原因和「后面的步骤没做」，后面的 cua 动作没有被调用。
6. 概率低 → 停下，没调用动作工具。
7. 点击后两次观察都没变化 → 停下。
8. `signal` 中止 → 停下。

## 9. 交付前必须做
1. `npm run check`（仓库根目录）全部通过。跑之前确认 `node_modules` 可用。
2. `wc -l` 新文件和 `index.ts`，都 ≤600（`index.ts` ≤600）。
3. `docs/MODULES.md` 登记新文件。
4. **不要** commit、push、打 tag。改完就停。
5. 用中文汇报：改了哪些文件（每个一句）、复用了什么（硬规则 1）、`npm run check` 的结果（贴最后几行）、哪些地方你不确定。
