状态：已批准（第三版实现方案，2026-11-05；第二版见 [fast-executor-v2-impl.md](fast-executor-v2-impl.md)，总设计见 [fast-executor.md](fast-executor.md)）

# 快速执行者第三版：通用地少走轮次

## 0. 依据（实测数据，不是猜的）
- 每轮大模型约 8–14 秒，**和上下文大小无关**：每轮约 4 万 token 几乎全命中缓存，新输入只有几百，输出只有 25–250 token。所以只有「少走轮次」有用，压缩上下文没用。
- 通用测速三项基线（dev:live，测速助理 gpt-6.1-sol，第二版代码）：网页表单 81.7 秒；网页搜索 → 点开 → 读结果 125.7 秒；计算器算乘法 246.5 秒。
- 多出来的轮次有 4 个原因，都和具体页面无关：
  1. **看不到非按钮的内容**：窗口只取了可操作元素，计算器显示屏（`AXStaticText = "7,006,652"`）这类文字被丢掉了。于是「点了有没有变化」判断错误，误判成「点了但页面没有变化」停下；结果里也读不到答案，大模型只好再带截图读。任何「点按钮只改显示内容」的应用（计算器、计数器、播放器、状态栏）都会这样。
  2. **要大模型抄长串编号**（target_id / tab_id / pid / window_id），抄错一位就白跑一轮（实测出现过）。
  3. **快速打开挑错窗口**：取 z_index 最大的那个，碰上 Chrome 的辅助窗口，绑定被拒（cua 原话：using the browser's main window and pid, not a helper），大模型只好自己一步步重来。
  4. **打开和动手要分两轮**：几乎所有电脑任务都是「打开某个东西 → 在里面做事」，现在打开一轮、做事一轮、核对一轮。

## 1. 要改的 5 件事（不加新工具，不改审批）

### 1.1 观察结果带上非按钮的文字：`packages/ext-computer/src/quick-steps.ts`
- 新增纯函数 `windowTextRows(text: string): string[]`：从 `get_window_state` 返回的**文字树**里，取出**没有 `[N]` 编号**的行（这些是不可操作、只用来显示的元素），格式例如
  `    - AXStaticText = "‎1,234‎×‎5,678"`、`    - AXHeading (标题)`。
  规则：行去掉首尾空白后以 `- ` 开头、紧跟着的不是 `[`；取出 role（第一个词）、括号里的名字、`= "…"` 里的值；去掉 U+200E / U+200F 这类方向控制字符；名字和值都为空的不要；输出 `role「名字」=值`（没有名字时写 `role=值`）。最多 60 行。
- `summaryOf` 窗口分支：把 `windowTextRows(text)` 的结果放在**最前面**，后面接原来的 elements 行。`summaryOf` 增加 `text` 参数，`parseObservation` 里传进去。
- `fingerprintOf` 增加第 4 个参数 `extra: string`，拼进被哈希的字符串；`parseObservation` 里传 `summary`（网页的 outline 也一并算进来，这样只改文字、不改按钮的页面变化也能看出来）。`emptyObservation` 传空串。
- 这样 `verifyStep` 不用改：显示内容一变，指纹就变，「页面有变化」就判对了。

### 1.2 结果里直接写「变了什么」：`quick-steps.ts`
- 新增纯函数 `changedText(before: string, after: string, max = 600): string`：把两段 summary 按行拆开，返回**在 after 里、不在 before 里**的行（保持 after 里的顺序，去重），拼起来最多 `max` 字；没有就返回空串。
- `summarize(results, stopped, lastObs, firstObs?)` 加第 4 个参数 `firstObs`（第一步之前读到的观察）。做完或停下时，如果 `changedText(firstObs.summary, lastObs.summary)` 不为空，在「最后的页面内容」**前面**加一行：`页面上新出现 / 变了的内容：\n<那些行>`。
- 两个循环都要传 firstObs：`quick-steps-tool.ts` 的快速执行循环在第一次 observe 后记下；`quick-goal-run.ts` 同样记下第一次读到的 obs，在末尾也输出这一行（用同一个 `changedText`）。

### 1.3 记住「当前目标」，target 可以不传：`quick-steps-tool.ts` + `quick-open.ts`
- `registerQuickSteps` 里建一个闭包变量 `let current: QuickTarget | null = null;`，通过 `QuickStepsOptions` 新加的可选字段传给 `registerQuickOpen`：`remember?: (t: QuickTarget) => void`。
  - `quick_open` 成功后调用 `remember(target)`；
  - `quick_steps` 每次成功开始执行（target 校验通过）后 `current = target`。
- `quick_steps` 的参数里 `target` 改成 `Type.Optional(...)`；执行时 `const target = p.target ?? current;`，都没有就报错「没有当前目标：先用 ${openName} 打开，或传 target」。
- 工具说明和提示词里写：「target 可以省略，默认用最近一次打开 / 操作的那个」。

### 1.4 快速打开挑对窗口：`quick-open.ts`
- `frontWindow` 换成 `windowsInOrder(s)`：返回窗口列表，排序规则依次是：`layer` 为 0 或没有的在前；`is_on_screen !== false` 的在前；`title` 非空的在前；`z_index` 大的在前。
- 网页分支：按这个顺序**逐个**试 `get_browser_state {pid, window_id, session}`，第一个 `binding_quality === "exact" && mutation_allowed === true` 的就用；都不行时，如果最后一次结果里有 `next_call.arguments.window_id`（cua 建议的窗口），再试一次那个；还不行才报错（报错信息沿用现在的）。最多试 5 个窗口。
- 应用分支：`waitWindow` 返回 `windowsInOrder(...)[0]`（不再只看 z_index）。

### 1.5 打开的同时就动手：`quick-open.ts`
- `quick_open` 的参数加上和 `quick_steps` **完全相同的** `steps` / `goal` / `inputs` / `max_steps`（都是可选的；复用 `quick-steps-tool.ts` 里的参数定义，不要再写一份：把那几个 `Type.*` 定义提成导出的常量 `QUICK_ACTION_PARAMS`）。
- 打开并读完页面后：给了 steps 或 goal，就**直接在同一次调用里**执行（调用 `quick-steps-tool.ts` 导出的执行函数，见下），返回「打开结果 + 执行结果」；都没给就照旧只返回打开结果。
- 为此把 `registerQuickSteps` 里 `execute` 的主体（从参数校验到返回）提成导出函数 `runQuickAction(ctx, o, target, params, signal)`，`quick_steps` 和 `quick_open` 都调它。**不要复制循环代码。**

### 1.6 提示词：`quickStepsPrompt`
改成下面这样（工具名用变量）：
```
<quick-steps>
电脑操作尽量少来回，每一轮都要好几秒：
1. 打开网页或应用用 ${open}；已经知道要做什么，就把 steps（或 goal + inputs）一起传给它，打开和做事一次完成。
2. 之后在同一个页面上接着做，用 ${steps}，target 可以省略（默认用最近打开 / 操作的那个）。
3. 结果里已经写了「新出现 / 变了的内容」和最后的页面内容，够用就直接回答，不要再读一遍、不要再截图核对。
4. 互不依赖的准备（比如先找文件路径）和打开放在同一轮里一起调用。
5. 要提交 / 发送 / 删除之类的，goal 或 steps 里要明确写出来；停下时按原因和元素列表用普通工具接着做，被拒绝的动作不要换方式重试。
每个动作照常按用户的权限档位审批。
</quick-steps>
```

## 2. 单测（`packages/server/test/`，照现有写法）
- `quick-steps.test.ts`：`windowTextRows` 能从示例文字树（用 §0 里计算器那段）取出 `AXStaticText=1,234×5,678`、去掉 U+200E、跳过带 `[N]` 的行；窗口 summary 以显示屏那行开头；只改显示文字时 fingerprint 会变；`changedText` 只返回新增行。
- `quick-steps-tool.test.ts`：不传 target 时用上一次的 target；第一次就不传 → 报错文案对；结果里出现「页面上新出现 / 变了的内容」。
- `quick-open.test.ts`：第一个窗口绑定返回 heuristic、第二个 exact → 用第二个；都不行但有 next_call → 试 next_call 的窗口；带 steps 时同一次调用里执行了步骤（executeTool 里能看到动作调用）、并记住了 target。
- `quick-goal-run.test.ts`：末尾也带「页面上新出现 / 变了的内容」。

## 3. 约束
- 文件行数：每个文件不超过 600 行；`index.ts` 不能变长。
- 不改审批、不改 Pi / node_modules / 依赖版本；不 commit / push；不跑真机。
- 改完 `docs/MODULES.md` 里 quick-steps.ts / quick-open.ts 那一行补一句新能力。

## 4. 验收（Claude 来跑，dev:live）
同一组三项任务（表单、商店搜索、计算器）各跑一次，和 §0 的基线比秒数和工具调用次数；三项都变少才算有效。决策模型（Jev）不可用时，名字完全对上的步骤照常不问它，目标模式会停下说明原因。
