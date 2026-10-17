# 请求级 Fast（service_tier）+ 紧凑两层模型弹层 · 进度快照

- 日期：2026-10-17（本机 `date`）
- 工作树：`fast-inference-mode-implementation`（从 `thinking-slider-visual-refinement` HEAD `8b8d836` 新建）
- 分支：`fast-inference-mode-implementation`；状态：**候选，未 push / 未 tag / 未合 main / 未打包 / 未安装 App**
- 保留：`8b8d836` 用户已批准的粗渐变轨、实心无字白圆、居中 strength、模型名次行（未改视觉）
- 合同：`docs/design/fast-mode-contract.md`；需求行：`docs/ROADMAP.md` 顶部；交接：`docs/HANDOFF.md`

## 已完成

1. **服务端（公开 hook）**
   - 新 `packages/server/src/pi-adapter/fast-mode.ts`：`planFastRequest`（关闭不附加、开只加 `service_tier: priority`、已有 tier 尊重并分 conflict / externally-configured）、终止 / 非终止回显分离、`attachFastMode` 组合已有 `onPayload` / `onProviderStreamEvent`（修复过「不改时返回 undefined 吞掉前一个 hook 替换结果」）。
   - 状态：`agents.fast`（0/1）+ `subagents.fast`（NULL 跟随）；助理 / 子代理独立，`resolveSubagentFast` 跟随 + 覆盖；`setSubagentFastOverride`。
   - 路由：`PATCH /api/agents/:id {fast}` 只改 fast；`PATCH /api/subagents/:id {fast}` 只改覆盖；`GET /api/models` 附能力；`agentJson` 返回 `fast`；子代理详情返回 `resolvedFast`。
   - runtime：主会话 / 后台任务 / 子代理创建后挂 tracker；`meta.fast` 只存短对象；**开着但未发送（unsupported-api / bad-payload）也记录**；错误 assistant_end 也带 fast 状态。
   - 能力口径：`supported` 暂不自动返回（没有服务级声明），OpenAI 兼容也标 `requestable-unverified`；不支持统一「当前接口暂未接入 Fast」，不写「Anthropic 没有 Fast」。

2. **前端**
   - 四角星 → 闪电真按钮（`Zap`，44px 命中区，`aria-pressed` / `aria-disabled` / `aria-busy`）；延迟 ~450ms 提示（`useHoverTip` 复用 Help 气泡定位 / Esc / 外点，保留 help / help-pop testid）；focus 立即、触摸点按同时显示并切换；保存中禁重复。
   - 主题 token + glass / warm / noir / pixel 覆盖；reduced-motion 无额外动画。
   - 消息下方 `Fast · …` 状态：终止 default 只写「服务回显 default（实际加速未确认）」；非终止写「来源未确认」；无回显写「已请求」；费用「部分站点约 2 倍或更高，以服务商账单为准」。
   - **两层紧凑弹层**：聊天入口默认强度 + 可点击模型名 + Fast + 滑块；点模型名进完整目录（搜索 / 服务分组 / 常用保留）；返回 / 选完回紧凑层；Esc 目录退一层；焦点回模型名 / 触发器；390 走底部弹层。状态纯函数 `pickerPanelNext`；管理入口（默认模型设置、组队成员）仍直接目录。
   - 子代理 Fast：跟随 / 独立覆盖 UI；保存失败只回滚 fast 字段 + 代次守卫（不覆盖轮询消息）；`patchAgentFast` 只合并 / 回滚 fast。子代理模型由候选池决定，不在弹层换模型。

3. **测试（轻量，已跑）**
   - `packages/server/test/fast-mode.test.ts` **14/14**（Node 24.19.0；真实 `createPiSession` → loopback fake OpenAI 抓最终 payload）：关无字段、开只多 priority、`reasoning_effort` 具体 `medium` 不变、再关恢复；组合 hook；已有 tier 不被覆盖；400 / 403 各只发一次；终止 / 非终止回显；换模型按实际 api；助理独立 / 子代理跟随覆盖。
   - 前端纯逻辑 + 静态 DOM **43/43**（review 修复后 44/44）：`e2e/fast-mode-frontend.test.mjs`（default 文案 / 来源未确认 / 已请求 / externally-configured）、`e2e/thinking-slider-frontend.test.mjs`（闪电 / aria / 非推理仍可用 / 空态 / 加载失败不误报）、`e2e/model-menu-two-level.test.mjs` 5/5（初次紧凑 / 点模型名 / 返回 / 选完 / Esc / 管理入口）。
   - 两端 `tsc --noEmit` 0（server / web）。


## review 修复（2026-10-17，同树，候选未发布）

主会话复核 `8a6b18b`（独立复跑 14 + 43 = 57/57，Node 24.19）后指出 6 点，按实际代码逐条核对并修：

1. **群聊入口**：`rg` 确认 `RoomChat` 没有 `ModelPickerButton` / Fast —— 这是既有产品设计（群成员各自是一个助理，模型 / 思考 / Fast 在该助理自己的输入栏设置），不是本功能的漏接。因此不另造群聊紧凑层；Fast 用**每个成员助理的 `agents.fast`**（主会话 / 后台 / 子代理 / 群成员对话在 `runtime.ts` 同一条会话路径），群消息的 `Fast · …` 与单聊共用 `BotTurn` 里的同一段。合同 §7 写明「不把主会话有写成群聊也完成」。
2. **`patchAgentFast` 保存竞争**（`ModelPicker.tsx`）：改为**每个助理一份 `LatestWrite`**（复用 `latest-write.ts`）：只认最新一次，迟到成功不写确认值、迟到失败不回滚，回滚用服务端确认值；`ModelPicker` 加组件本地代次，切助理 / 卸载只清自己的 pending / error。没有新增 writer 或大框架。
3. **子代理轮询盖 Fast**（`Subagents.tsx`）：`fastSaving` 期间轮询结果只保留本地 `fast` / `resolvedFast`，消息与状态继续刷新；`LatestWrite` 仍管代次；切子代理只清当前。
4. **Esc 先后 + 目录重复**：核对出菜单与气泡都在 `document` 捕获阶段、同一节点 `stopPropagation` 挡不住彼此 → 旧实现按 Esc 连菜单一起关。新增 `apps/web/src/esc-layer.ts`（按打开顺序的小栈）+ `ui.tsx` 的 `useEscLayer`，气泡与 `usePopover` 共用；`ModelPickerButton` 在两层入口下不再给目录传整块强度 / Fast（管理型入口不变）；键盘 Enter 打开焦点落模型名。
5. **加载 / 错误态**：`ModelPickerButton` 增 `error` / `onRetry`，`ThinkingSlider` 失败时给「模型目录没加载出来 + 重试」，不再显示成「不支持」。
6. `packages/server/test/fast-mode.test.ts` 能力口径用例标题改成与断言一致（全部 `requestable-unverified`，官方 Responses 也不是 `supported`）。另：错误消息也显示 `Fast · …`。

**本轮实跑**（Node 22.23.3 副本；临时 HOME / DATA / WORKSPACE / TMPDIR + 内存凭据 + loopback 假 HTTP）：`packages/server/test/fast-mode.test.ts` 14/14、`e2e/{fast-mode-frontend,model-menu-two-level,thinking-slider-frontend}.test.mjs` 44/44（合计 **58/58**，新增 1 条 Esc 归属测试）、`tsc --noEmit -p apps/web` exit 0。

**e2e 脚本已准备好、未运行**：新增 `e2e/model-menu-flow.mjs`（打开紧凑层 / 点模型名进目录 / 关到底）、`e2e/fast-mode-ui.mjs`（悬停说明、Esc 只关说明、真实 PATCH 保存 + 刷新持久化、失败回滚与原因、键盘焦点、390、不支持协议不发请求）；`model-ui` / `model-picker-favorites-ui` / `thinking-slider-ui` / `thinking-slider-visual` / `composer-compact` 的打开路径改到紧凑层。浏览器环境等 heavy 槽的 native env helper 接线，`fast-mode-ui` 未接线时以退出码 2 说明（不会用真实 HOME 起 Chrome）。

## 未完成 / 未验（如实）

- **Chrome / 真实构建 UI 贯通与截图、390 实际渲染、真机 App**：按主会话要求暂时让出 heavy 槽，**没有跑**；相关 Playwright 断言未新增执行。两层弹层目前只有纯状态测试 + 静态 DOM，**不能声称浏览器实际交互已验收**。
- 真实中转（含 sub2api 实际部署）与真实付费请求：**未发**；站点策略（filter / block / force_priority / free_openai_fast）、倍率、账单均未知。
- 全量 `npm test` / 全量 e2e 未跑。
- `supported` 三态目前无服务级声明可返回；不声称任何服务对具体模型真支持。

## 提交

- `ca7376d` 服务端：hook 注入 + 状态 + 能力口径
- `4d2d4a6` 界面：闪电 / 延迟提示 / 消息状态 / 模型菜单接入（两层改造前 checkpoint）
- `5d1d7db` 修复组合 hook 吞替换结果；补 400/403、终止事件与 reported 口径测试
- 本轮后续（两层弹层 / review 修复 / 文档）见 `git log --oneline`

## 下一步（需要主会话安排 heavy 槽）

1. 真实构建 + Chromium 跑两层弹层 / 延迟提示 / 390 / Esc 焦点 / 回滚截图（建议新增 `e2e/fast-mode-ui.mjs`，届时再写）。
2. 真机 App 验证 PATCH 持久化、WS 刷新、子代理跟随覆盖；真实中转文档与计费核对。
