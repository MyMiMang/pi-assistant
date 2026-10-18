# 快速操作模型 · 真实操控基准测试的「一键真实环境」

状态：已废弃（快速候选选择器已撤下，见 decisions/0005）

更新时间：2026-10-22（Asia/Shanghai）
分支：`benchmark-environment-bootstrap`（worktree，基 `benchmark-production-fix` `437116f`，**本地提交，未 push / 未 tag / 未打包**）

## 问题

`benchmark-production-fix` 把「假可跑」修成「真可跑或明确 unsupported」，但生产主入口
`createRuntimeBenchmarkHost` **没有任何隔离窗口 / 宿主网关的真实来源**：

- `hostIsolatedWindow` 默认 `false`，运行时也从不传 → 用户电脑目标永远 blocked；
- `computerFixtureBaseUrl` 默认 `null`，运行时也从不传 → 助理电脑目标永远 blocked。

结果 UI 上「开始实际操作测试」按钮在两台电脑上默认都点不动，用户要么手填网关地址，要么给一个安全上无效的开关。
用户要的是**点一下就真跑**。

## 设计

### 1. 能力探测只报「可准备」，不开窗口

`benchmark-window.ts::planFixtureWindow` 只吃目标 cua MCP 的 `tools/list`，**没有任何副作用**：

- **hostpc**：必须能拿到**驱动自有的隔离浏览器**（`browser_prepare` + `browser_navigate` + `get_browser_state`），
  否则 fail-closed —— 绝不用用户日常 Chrome / `launch_app` 打开用户默认浏览器当 sandbox。
- **computer（助理电脑 VM）**：天然隔离 + 需要 `launch_app` / 窗口工具 + 一个**已证实**的 guest 可达宿主别名；
  有驱动自有浏览器能力时优先用隔离浏览器（独立 profile / 窗口），否则退回 `launch_app` 专用窗口。

`GET /api/fast-computer/benchmark` 的 availability 只回 `preparable` / `targetKind` 元数据，**绝不开窗口**。
真正的窗口生命周期在 `POST /api/fast-computer/benchmark`（用户点「开始实际操作测试」）里执行：
**先建窗口 → pin 精确身份 → 再开始跑**。

### 2. 专用 fixture 窗口生命周期（`benchmark-driver.ts`）

`driver-isolated-browser` 路径（hostpc / 具备能力的 computer，字段以官方 cua-driver 0.35.4 为准）：

1. `browser_prepare { allow_launch: true, profile: { mode: "isolated_new" } }` —— 官方 attested 的驱动自有隔离 profile，
   不接受任意 argv，模型 / 用户都不能手写 profile 去破权限；**隔离启动只返回 `prepared_pid`，不返回 `target_id`**；
2. `list_windows { pid: prepared_pid }` —— 列该自有进程的窗口，pin 原生 `window_id`；
3. `get_browser_state { pid, window_id, snapshot_format: "semantic_v2" }` —— 绑定并拿 `target_id` / `tab_id`（此时 URL 还是空白）；
   要求 `binding_quality:"exact"` + `mutation_allowed:true`，字段缺失一律 fail-closed；
4. `browser_navigate { target_id, tab_id?, url }` —— URL 带本次随机 `fixtureId` + `nonce`；
5. `get_browser_state { target_id, tab_id?, snapshot_format: "semantic_v2" }` —— 复核 URL 同时含 `fixtureId` + `nonce`，并取回 `snapshot_id`；
6. 结束后**只 kill 驱动自有浏览器的 pid**（`kill_app`）；拿不到自有 pid 就不关，绝不 kill 用户浏览器 / 别的窗口。

> 修正（2026-10-22 复核）：上一版把 `target_id` 当成 `browser_prepare` 的返回字段，并校验 `isolated_owned`。
> 实际 cua-driver 0.35.4 的隔离启动只给 `prepared_pid`，`target_id` / `binding_quality` / `snapshot_id` 都来自
> `get_browser_state` 绑定；二进制里**不存在 `isolated_owned`**（原校验是空操作），已删除。若不修，隔离路径会永远 fail-closed。

`sandbox-app` 路径（助理电脑退回方案）：`launch_app({urls})` 打开 fixture 窗口，`list_windows` 唯一命中
`fixtureId`+`nonce` 的窗口，再 `get_window_state` pin 身份。

### 3. 受限权限桥（`benchmark-guard.ts`）

基准经 HTTP 跑，**没有 Pi 的 tool_call ctx**，所以所有 backend 调用统一过 `benchmarkToolGuard`，不把目标当 always-allow：

- 目标已暂停（hostpc 一键暂停 / 助理电脑暂停）→ 拒绝一切（含读取）；
- 用户档位是「只看」（observe）→ 只允许读取，输入动作拒绝，**不弹多余审批**，明确 blocked 让用户调档位；
- 无论档位，`run_script` / `run_actions` / `set_config` / `replay_trajectory` / `escalate_session` 等一律拒绝 ——
  不能借基准逃「`run_script` 已关闭」等规则。

### 4. 窄网关 + 别名解析（`benchmark-gateway.ts` / `routes.ts`）

- fixture 前缀下只服务**本次 run 的 fixture 页 + 状态上报**，其它路径 / 方法一律 403；
- 状态上报要 nonce + 每次 run 的随机 token + 私有 / 回环来源 + 同源（`Origin`/`Referer` 若存在必须同源）；
- `resolveComputerFixtureBaseUrl` 按桌面运行时推断 guest 可达宿主别名：Docker Desktop（macOS/Windows）→
  `host.docker.internal`，Lima → `host.lima.internal`；Linux 原生 docker / 未知 → `null`（fail-closed）。
  **绝不回退 127.0.0.1，也绝不把控制 API 绑到 0.0.0.0。**

fixture 页是服务端固定模板，主 API 只透传这个固定 template，不接受任意用户脚本。

## 生产路径（当前实现）

```
GET  /api/fast-computer/benchmark            → availability（含 preparable/targetKind，无副作用）
POST /api/fast-computer/benchmark            → 用户点了「开始实际操作测试」才：
     planFixtureWindow（tools/list）→ openFixtureWindow（browser_prepare/launch_app + pin）→ startBenchmark
     结束后只关自有窗口
```

## 未真机边界（重要）

- **未在真实桌面上验证**：本环境未开 hostpc、未跑助理电脑 VM；字段名已对照本机 cua-driver 0.35.4 二进制内嵌文档确认
  （`browser_prepare` 隔离启动返回 `prepared_pid`；`get_browser_state` 绑定返回 `binding_quality` / `mutation_allowed` / `target_id` / `tab_id` / `snapshot_id`；
  `isolated_owned` 不存在），但**真实调用序列未跑通**（需 hostpc + 真浏览器）。形状不符一律 fail-closed。
- **别名可达性未验证**：`host.docker.internal` / `host.lima.internal` 能否从 guest 浏览器的网络命名空间访问到
  绑定 127.0.0.1 的 Pi fixture 服务，**未在真实 VM 上实测**；拿不到就是 `null`（blocked），不假装可用。
- 单测里的假 driver **不代表 native 支持**；本文件不声称已支持，只描述实现与边界。
- 未跑全量单测 / 全量 e2e；未安装 App、未开用户电脑 / VM / 浏览器、未碰系统钥匙串、未读 `secrets.ts`。

## 已跑（Node v24.20.0，全程假 driver / 本地内存 HTTP，未开真实桌面）

- 两端 `tsc --noEmit` exit 0（server + web）。
- `fast-computer*` + `host-control` **89/89**；连同 `classifier` **96/96**。
- 新增 `fast-computer-benchmark-window.test.ts` 9 项：窗口计划 / 绑定收紧 / driver 隔离浏览器 bootstrap 序列 /
  权限桥（暂停 + 只看 + run_script 拒绝）/ 别名解析 / **真实本地 HTTP 窄网关**（取页 + 上报 + 非白名单 403 + 跨源 403）/
  GET 不开窗、POST 才开窗。
