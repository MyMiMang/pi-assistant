# native-dialog-ui-fix（原生 confirm / alert / prompt 同类 UI 根治）

分支 `native-dialog-ui-fix`，独立 tree，基线 `hotfix-integration` = `91d3b94`（含渠道删除修复 `91d3b94` / 单测数据隔离 / 外链 / 向导，等于 main `8d7a7d8` + 4 个 hotfix）。未 push / 未 tag。
工作树：`/Users/dengdeng/Library/Application Support/Pi Assistant/workspace/amv7oy7ejb00/native-dialog-ui-fix`。

## 背景
`945148e`（= `91d3b94`）已修好「设置 › 渠道」删除按钮：原生 `window.confirm` 在 Tauri 2 的 remote webview 里**不弹窗且返回 false**，导致点删除没有任何反应。根因是同类 UI 里仍散落一批 `window.confirm/alert/prompt`，同一个坑会逐个复现。本次把 web 界面里**残留的原生 dialog 全部换成应用内共享 `useConfirm` / `Modal`**。

## 本次改动（最小复用，不加 dialog 插件 / 不引新框架）
统一用 `apps/web/src/components/ui.tsx` 已有的 `useConfirm()`（ConfirmDialog）和 `Modal`；`alert` 改成组件内既有 inline 错误提示（本项目没有 toast 系统）；`prompt`（对话改名）改成应用内 `Modal` + `Input`。

| 文件 | 改动 |
|---|---|
| `ui.tsx` | `Modal` 加**弹窗栈**：只让最上层响应 Esc。修掉「设置弹窗里的确认框按 Esc 会把底层设置弹窗也一起关掉」。 |
| `Settings.tsx` | 远程访问「冷却期重试」、`alert`（设为主人失败）→ inline；入口页「删除远程入口」；固定地址「删除固定地址」→ `useConfirm`；两个删除按钮加 `data-testid`。 |
| `ExtensionsTab.tsx` | 删除 MCP 服务、卸载扩展包 → `useConfirm` + 删除中禁用/转圈 + 失败 inline + 防双击 ref。 |
| `Email.tsx` | 删除邮箱 → `useConfirm` + 删除中禁用 + 失败 inline。 |
| `Conversations.tsx` | `alert`（整理上下文失败）→ inline；`prompt` 改名 → 应用内 `Modal`（非空校验、Enter 提交、Esc 只关当前层）；删除对话 → `useConfirm`。 |
| `MemoryTab.tsx` | 删除记忆 → `useConfirm` + 失败 inline。 |
| `SkillsTab.tsx` | 删除技能、回滚版本 → `useConfirm` + 失败 inline。 |
| `DesktopSettings.tsx` | 删除虚拟机和镜像（purge）→ `useConfirm`（确认框写明「登录状态会清掉、下次要重新下载」）。 |
| `e2e/native-dialog-ui.mjs`（新） | 纯前端 fixture（静态 dist + `page.route`，**不启动 main.ts、不碰钥匙串**）覆盖全部改动。 |

## 已验证（实际跑过）
- `npx tsc --noEmit -p apps/web`：exit 0。
- `npm run build -w @pi-assistant/web`：通过。
- `node e2e/native-dialog-ui.mjs`：**全部通过**。10 段覆盖 MCP 删除 / 扩展包卸载 / 邮箱删除 / 助理电脑 purge / 远程访问冷却期重试 / 远程入口与固定地址删除 / 记忆删除 / 技能回滚+删除 / 对话改名（空名校验、Enter 提交、Esc 不关底层）+ 删除 / 390 窄屏。
  断言：取消 → 0 请求；确认一次才发请求；服务端失败显示可读文案且条目保留；删除中按钮禁用、慢响应双击只发一次；确认框写明风险；Esc 只关当前层（底层设置弹窗 / 对话菜单不关）；390 宽确认框不溢出；**全程 `page.on('dialog')` 计数为 0**；页面无未捕获错误。
- 回归：`node e2e/channel-delete.mjs`（已有渠道删除用例）仍通过，确认 `Modal` 弹窗栈改动没影响它。

## 未验证 / 边界（不宣称）
- 未安装 App、未真机点按钮（按要求不动用户桌面、不装 App、不跑真实 desktop/VM、不碰钥匙串、不碰真实数据）。
- 全仓库其余 `confirm/alert/prompt` 只出现在：扩展接口声明（`packages/ext-routines` / `ext-skills` 的方法签名）、测试里的 `javascript:alert(1)` 字符串、`DesktopView`/`AgentComputer` 里**已是应用内 `useConfirm`** 的 `confirm({...})`——均非原生 dialog，本次不动。

## 合入说明（给主会话）
- 基线是 `hotfix-integration`（含 `91d3b94`），与整合树的 `945148e` Channels 修复同源，**不碰 Channels.tsx**。
- 与 `f1fcf11`（App/models/http）、`f863e48`（外链）、`945148e`（Channels）应无冲突：本次只改上表 8 个组件 + 新增 1 个 e2e，其中 `ui.tsx` 的改动只影响 Modal 的 Esc 行为。
- `Settings.tsx` / `DesktopSettings.tsx` 的既有资源功能未删改，只替换了删除确认的交互。
