# UI 一致性与动效规范

> 状态：**beta.28 候选，未发布 / 未 push / 未 tag**（工作树 `ui-consistency-motion`，基 `release-candidate-validation` `6d6c1ee`）。
> 本文是"规则与标准"，不是验收报告；实跑与未验边界见文末「本轮落地与验证」和 `docs/HANDOFF.md`。
> 借鉴对象：**open-claude-ui**（固定提交 `ddf3aea1711db62fd6d24343bbab500a5ae69f64`，MIT）。只借鉴**设计思路、规范化与动效组织方式**，**未复制其代码**（因此无需写入 `THIRD_PARTY_NOTICES.md`）；不引入其 logo / 字体 / 专有素材，不替换现有 5 套皮肤与用户 DIY 主题。
> 完整研究报告：`research/pi-ui-consistency-and-motion-proposal.md`。

## 0. 唯一规范源

`apps/web/src/components/ui.tsx` + `apps/web/src/themes/*.css` 是唯一规范源。新控件优先复用其中的原子件与共享行为（`Button` / `Fold` / `Select` / `Modal` / `Help` / `ModelPicker` / `TaskRow` 等），**不新建 UI 框架**。带业务语义的卡片留在自己的模块。

## 1. 控件放在哪（按作用对象分层）

| 作用对象 | 位置 | 例子 |
|---|---|---|
| 某条内容 / 当前实体 | 贴内容或实体 header | 消息的复制 / 引用 / 分支；任务卡 |
| **下一条要发的东西** | 输入框工具栏 | 附件、模型、思考强度、主动性、上下文环、语音、发送 |
| 全局偏好 | 设置页 | 默认模型、发送快捷键、本地模型安装 |

同一语义在主会话 / 群聊 / 子代理必须**同组件、同措辞、同快捷键**；唯一允许的差异是数据差异（可用模型集合、群聚合层级）。子代理「思考强度移入输入栏 + header 同页任务切换」由在修树 `subagent-composer-navigation` 负责，**本文不重复实现**。

## 2. 状态语义（loading / empty / error）

- **loading**：结果尚未就绪的等待。转圈只表示"还没好"，**不表示可计量进度**；有真实分母才显示百分比（真实字节 / 步数），没有分母用不定进度条，不造假进度。
- **empty**：一句话说清"还没有什么、在哪开始"，给唯一下一步入口；不沉默留白。
- **error**：一句中文摘要 + 可展开的详情（复用 `ErrorBox`）；保留旧数据、给重试；不吞错、不白屏。
- 文字流和"任务还活着"的状态必须有**真实事件依据**，不能靠循环动画证明任务仍在执行。

## 3. 折叠（Fold / Steps / `<details>`）

- 折叠是**受控**的：用户可以随时收起再展开；**折叠后仍显示当前状态**（步骤数、成功/失败、用时）。
- **不采用**"生成中强制展开、剥夺折叠权"。
- 步骤列表：进行中默认展开，**用户手动收起后，后续流式更新不得把它重新弹开**；完成后自动收起；用户手动展开后不再被自动收起覆盖。
- 展开显示**完整内容**，不用固定 `max-height` 截断长内容；用真 grid `0fr↔1fr` 做收起动画，**不对长 Markdown / 长列表做高度过渡**（避免滚动抖动）。
- 原生 `<details>` 仅用于低频、无受控需求的场景（如任务说明）；需要"折叠后仍显示状态 / 受控开合"的用 `Fold` / `Steps`。

## 4. 原生 `<select>` vs 应用内 `Select`

原生 `<select>` 只用于：设置页**低频、单值、约 20 行内、无分组 / 搜索 / 多选 / 富文本**的选择（如频率、星期、币种）。
出现**分组、搜索、多选、选项描述、锚定翻转、动态 / 长列表**任一时，用应用内 `Select`（`ui.tsx`，自带定位、翻转、键盘与焦点处理）。
同一页同类优先统一；简单低频的原生 select 可以保留，**不做全仓 26 处扫改**。

## 5. 动效 token 与减弱动效

token 定义在 `themes/base.css`（`html` 上，弹层 portal 到 body 也能取到）：

| token | 值 | 用途 |
|---|---|---|
| `--pa-dur-fast` | `.12s` | 按下 / 悬停这类即时反馈 |
| `--pa-dur` | `.18s` | 常规状态切换 |
| `--pa-dur-slow` | `.26s` | 折叠 / 展开这类形变 |
| `--pa-ease-out` | `cubic-bezier(.2,.8,.2,1)` | 通用缓出 |
| `--pa-ease-expand` | `cubic-bezier(.22,1,.36,1)` | 展开 |
| `--pa-ease-spring` | `cubic-bezier(.2,.9,.3,1.35)` | 轻微回弹（仅装饰） |

- 本轮只把**公共控件 / 下拉 / 折叠 / 任务状态**接到 token；**不批量替换**其它既有硬编码时长，保住各主题（尤其 pixel）的原调性。
- 弹窗 / 下拉 / 折叠内容只做温和的透明度 + 轻微位移进入；**关闭 / 取消立即生效**，不为离场动画延迟状态（需要大改 Modal 生命周期的退出动画暂不做）。
- **`prefers-reduced-motion: reduce`**（规则集中在 `themes/app.css` 末尾，最后导入可盖过各主题键帧）：关闭非必需的循环 / 位移 / 缩放动画；`spinner` 停转但保留强调色半环、`shimmer` 停止后不留透明字、不定进度保留静态块；**真实音量条仍随真实 level 更新**（只去掉过渡），不"假装冻结"。
- 滚动：折叠 / 展开不能改变用户的滚动位置或遮挡内容；浏览器 scroll anchoring 默认开启，不破坏它。

## 6. 触摸 / 鼠标 / 键盘三路可用

- `:focus-visible` 保持可见焦点（沿用各主题的 `--acc` 环，不覆盖高对比主题的既有 ring）。
- 弹层：`Esc` 关闭本层（不吃掉底层弹窗的 Esc）、点外部关闭、关闭后焦点回到触发器。
- 触摸：点击区足够大（≥44px 目标）；只允许竖向拖动页面，宽内容在本块内横滚（见 `themes/app.css` 的手机防横晃规则）。
- 键盘：下拉支持上下键 / Home / End / Enter / Space；折叠支持 Enter / Space。

## 7. 本轮落地与验证

**落地（工作树 `ui-consistency-motion`）**：
- `themes/base.css`：新增 `--pa-dur* / --pa-ease*` token；公共控件 / 下拉 / 折叠 / 步骤的过渡改用 token；修 `Steps` 冲突规则——去掉 `display:block;max-height` 覆盖与 240 / 420 不一致，改真 grid `0fr↔1fr`，展开显示完整内容。
- `themes/app.css`：删掉 `max-height:420px` 覆盖；加 `Modal` / `.pa-pop` / `.pa-menu-in` / `.pa-fold-in` 的温和进入动画；加 `prefers-reduced-motion` 规则块。
- `components/ChatMessages.tsx`：`Steps` 结构改为外层 grid + 内层 `ol`；`aria-expanded`；用户手动收起后不被流式更新重新弹开。
- `components/ui.tsx`：`Select` 菜单加 `pa-menu-in`；`Fold` 展开内容加 `pa-fold-in`。
- `components/CustomProvider.tsx`：同页混用里把**动态 / 可能很长的**测试模型列表改用 `Select`；3 值的小枚举「API 类型」保留原生 select。

**验证（需要测试槽，见 `docs/HANDOFF.md` 对应条目）**：纯前端 DOM 夹具 `e2e/ui-consistency-motion.mjs`（静态 `dist` + `page.route`，不启真实后端、不碰用户数据）覆盖：长步骤展开不截断、运行中可收起、新流不弹开、弹窗 / 下拉 / 折叠的 Esc / 外部点击 / 焦点、`reduced-motion` 无循环位移、390 与桌面在多主题下不横向溢出。

**未验 / 边界**：真实观感与性能、真机（iPhone / 真 Safari）、全量 `e2e/run.mjs` 与全量 `npm test` 未跑；未改用户 DIY 主题 manifest schema；不做 sidebar 重排 / pin / drag。
