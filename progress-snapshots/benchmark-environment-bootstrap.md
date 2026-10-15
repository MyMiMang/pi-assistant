# benchmark-environment-bootstrap：真实操控基准的「一键真实环境」

更新时间：2026-10-22（Asia/Shanghai）
树：`benchmark-environment-bootstrap`（worktree，基 `benchmark-production-fix` `437116f`，基 `8d68f1e`，**本地提交，未 push / 未 tag / 未打包**）
边界：全程 Mock / 假 driver + 本地内存 HTTP；未开 hostpc、未跑助理电脑 VM、未碰系统钥匙串、未读 `secrets.ts` / SDK 凭据实现、未用真实 keys / 付费 API。

## 要解决的问题（用户原话大意）

65 个 mock 测试虽然通过，但生产主入口 `createRuntimeBenchmarkHost` 没有 `hostIsolatedWindow`、
`computerFixtureBaseUrl` 的真实来源，按钮在两台电脑上默认永远 blocked。用户要的是**一键真实测试**，
不是手填网关或安全无效开关；可内部可信推断，但不能强行置 true。

## 改了什么

### 新增 `benchmark-window.ts`（窗口来源计划，纯逻辑）
- `planFixtureWindow`：只凭目标 cua 的 `tools/list` 判断「可准备」，**无副作用、不开窗**。
  hostpc 必须有驱动自有隔离浏览器（`browser_prepare`/`browser_navigate`/`get_browser_state`）；
  computer 需要有窗口工具 + 已证实宿主别名，有隔离浏览器能力则优先它。
- `parsePreparedBrowserTarget` / `parseBrowserBinding` / `fixtureUrlMatches`：把 `browser_prepare` /
  `get_browser_state` 返回收紧成可 pin 的精确身份（target/tab/owner_pid、`binding_quality=exact`、
  `mutation_allowed`、URL 含本次 nonce、`isolated_owned`），形状不符 fail-closed。

### 新增 `benchmark-guard.ts`（受限权限桥）
- 暂停 → 拒绝一切；「只看」档位 → 只读、输入拒绝（不弹多余审批）；`run_script`/`set_config` 等一律拒绝。

### 新增 `benchmark-gateway.ts`（别名解析 + 窄网关纯逻辑）
- `resolveComputerFixtureBaseUrl`：Docker Desktop / Lima 给确认过的别名，Linux docker / 未知返回 null（fail-closed），绝不 0.0.0.0。
- `fixtureOriginAllowed` / `isFixtureGatewayPath`：状态上报同源校验、窄网关前缀判断。

### `benchmark-driver.ts`（真实 driver 路径）
- `driver-isolated-browser`：`browser_prepare allow_launch isolated_new` → `browser_navigate` → `get_browser_state`
  校验 → `list_windows`+`get_window_state` pin 原生 pid/window_id；关闭只 `kill_app` 驱动自有 pid。
- `sandbox-app`：保留 `launch_app` + `list_windows` + `get_window_state`。
- 所有调用过 `guard`（暂停 / 档位），拿不到身份一律抛错（fail-closed）。

### `benchmark-capability.ts` / `benchmark-host.ts` / `benchmark-runtime.ts`
- capability 接收 `window: FixtureWindowPlan`（旧 `sandbox` 字段兼容保留）。
- `BenchmarkDriver.capable` 默认 **fail-closed**（原来默认 true）。
- availability 加 `preparable` / `targetKind` 元数据（GET 只报可准备，不开窗）；POST start 才建窗口。
- runtime 去掉对 `hostIsolatedWindow` 的依赖，改用 `planFixtureWindow`；`computerFixtureBaseUrl` 默认按
  桌面运行时（`desktopBackend().id`）推断；guard 接入 `hostPaused`/`tierOf`/`desktopPause`。

### `routes.ts` / `http.ts` / web
- fixture 路由收紧成窄网关：非白名单路径 403、状态上报同源校验。
- `http.ts` 传 `desktopKind`；`desktop.ts` 加 `desktopRuntimeKind`。
- web `types.ts` 补 `preparable`/`targetKind`；`ModelServices.tsx` 就绪状态显示窗口来源提示。

## 实际跑过（Node v24.20.0，假 driver / 本地内存 HTTP）

- `tsc --noEmit`：`packages/server` exit 0、`apps/web` exit 0。
- `fast-computer*` + `host-control` **89/89**；连同 `classifier` **96/96**。
- 新增 `fast-computer-benchmark-window.test.ts` **9/9**：窗口计划、绑定收紧、driver 隔离浏览器 bootstrap 序列、
  权限桥（暂停 / 只看 / run_script 拒绝）、别名解析、真实本地 HTTP 窄网关（取页 + 上报 + 非白名单 403 + 跨源 403）、
  GET 不开窗 / POST 才开窗。

## 未做 / 未真机

- 未在真实桌面 / VM 上验证 `browser_prepare` / `get_browser_state` 真实字段；别名可达性未实测。
- 未跑全量单测 / 全量 e2e；未安装 App；未开用户电脑 / VM / 浏览器、未碰系统钥匙串、未读 `secrets.ts`。
- 详细生产路径与边界见 `docs/design/benchmark-environment-bootstrap.md`。
