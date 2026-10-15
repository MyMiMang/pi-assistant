# 按需工具发现（tool_search）+ codemode 批量编排：接入完整性与权限链验证

树：`pi-tool-discovery-validation`，基 `deps/pi-1.2.0`（2948a05）。只复用 Pi 公开 SDK，
不修改 Pi 本体 / node_modules / fork / 私有接口；不改全局默认（`direct` 仍是默认）。

## 结论（已用真实 PiSession 证明）

用真实 `createPiSession` + 临时 stdio MCP 服务器 + 脚本化 faux provider（无真实模型 / 凭据 / 外网），
13 个用例全过（单测单次 13/13，约 16s；`test/tool-discovery.test.ts`，每个用例 30s 上限）。
适配器现状（`packages/server/src/pi-adapter/index.ts`）已经注册
`createMcpExtension(autoEnableCodemode:true)` + `createCodemodeExtension({models:false})` + `createToolSearchExtension()`，
`codemode` / `tool_search` 由 MCP 扩展按服务器 exposure 自动激活——**不需要**改 `defaultTools`。

| exposure | 结果 |
|---|---|
| `direct` | MCP 工具直接声明给模型（`getActiveToolNames` 含 `mcp__demo__*`），不激活 codemode/tool_search |
| `deferred` | 只激活 `tool_search`；命中后 MCP 工具进入声明并可真实调用（结果来自 MCP 服务器） |
| `codemode` | 激活 `codemode`；MCP 工具不直接声明；脚本 `tools.mcp__demo__get_weather(...)` 真实执行；描述里列出授权命名空间、不含 hidden 服务器 |
| `hidden` | 不声明、`tool_search` 搜不到、脚本里 `tools.mcp__ghost__*` 报 Unknown（未授权不可调用） |
| 未启用 / 未派给该助理 | 不声明、不可搜、脚本调不到；发现类工具也不激活 |

权限链（ext-approval）：

- `codemode` 脚本里的嵌套 MCP 调用**仍走** `pi.on("tool_call")`：destructive 工具触发审批，被拒后
  **不执行**（临时 counter file 里没有 `send_note`），只读工具照常到达服务器。
- `deferred → tool_search 命中 → 模型直接调用` 同样过审批：destructive 工具被拒后未到达服务器。
  **未观察到公开工具派发绕过审批。**
- 完全权限（`hostAccess=true`）：应用层不创建任何审批请求，destructive MCP 直接执行；
  但脚本里调 `tools.bash({command:'cat ~/.aws/credentials'})`（虚构路径，命中 SECRET_PATHS）
  仍被拒绝，`ERR:` 返回、命令未执行。
- 取消：脚本 `slow_read → final_delete` 跑到 `slow_read` 时 abort，排队在后面的
  `final_delete` **没有执行**（counter file 无记录）。
- 出错：脚本调不存在的工具返回 `failed/Unknown` 清楚错误，不假成功。

## 真实字节采样（不推算 token / 不宣称节省）

同一 faux provider 记录每次模型请求实际收到的工具声明（`system.toolsAdded` 重放、按名字去重、JSON 字节数）：

- `direct`（1 个 MCP 服务器 4 个工具）：11 个工具 / 5591 字节
- `codemode`：8 个工具 / 7191 字节

**在这个规模下 codemode 的声明反而更大**（codemode 把 4 个 MCP 工具的声明内联进了自己的描述）。
所以本验证不主张“开 codemode 就降 token”；是否更优取决于工具数量与描述体积，保持 `direct` 默认，
需要时再由用户在已有 UI（ExtensionsTab 的 direct/deferred/codemode/hidden）逐服务器选择。

## 未验 / 边界（不宣称已完成）

- 只测了 stdio MCP 与脚本化 provider；真实云模型、真实 MCP（cua / 远程）未验。
- `models:false` 下 `codemode` 的 `models.classify/generateImages` 不开放；自有 generate_image / classifier 入口未受影响（沿用现状）。
- 未做真实电脑操作 / 未读真实密钥文件内容（按要求用虚构路径 + mock counter 工具）。
- 未改 UI 文案；ExtensionsTab 已有四种 exposure 选项，本次只补测试与文档。
- 未 push / 未 tag；不新增 fork / tree / 模板技能 UI。

## 文件

- `packages/server/test/tool-discovery.test.ts`（13 用例）
- `packages/server/test/fixtures/mock-mcp-discovery.mjs`（临时 stdio MCP 服务器，带 counter 记录副作用是否真的发生）
- 本次无生产代码改动：现有 `pi-adapter` 注册已足够，`direct` 默认保持不变。

运行：`node --import tsx --test test/tool-discovery.test.ts`（在 `packages/server` 下）。
