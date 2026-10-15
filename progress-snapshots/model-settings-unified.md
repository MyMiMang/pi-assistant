# 统一模型管理 + 本地 Laya + 实际操作测试（进度）

更新时间：2026-10-15（Asia/Shanghai）
执行者：后台子代理（统一模型管理 / UI 主实现）
树：`model-settings-unified`（worktree，基 `hotfix-integration` `b7d33d3`，已 merge `native-dialog-ui-fix` `9554628`）
状态：**本地提交，未 push / 未 tag / 未打包**。等主会话统一发布（仅 mac-arm64；跨平台源码 Laya 必须定义真实支持）。

## 已完成

- [x] 建树：`model-settings-unified`（基 hotfix-integration `b7d33d3`）。
- [x] 合并 `native-dialog-ui-fix`（`9554628`，原生 dialog → 应用内确认框），未丢既有资源 / modalstack / delete / onboarding / isolation / links。合并提交 `35992b1`。
- [x] 交互架构 + 接口契约文档：`docs/design/model-settings-unified.md`（一页精确交互架构、能力识别规则、legacy 无损迁移、最小 metadata DTO、Laya 安装/health/API 诊断契约、**实际操作测试**契约、平台支持矩阵、分工）。
- [x] 按用户纠正更新：性能测试 = **一次真实受控 CUA 任务**（不是 API 连接延迟）；按钮「实际操作测试」；需选测试电脑（assistant/host）；前置条件（permissions / VM ready）由用户明确确认；专用隔离窗口，失焦 abort，不碰真实 appdata；报告 success / 总时长 / errors / retries / mainFallback（非单 p50）；建议分「使用 / 谨慎 / 不建议」但仍允许选择；API 时延仅诊断。

## 待做（清单，按顺序）

- [ ] S1 UI 契约与原型（纯前端 fixture，复用 `Select`/`Modal`/`useConfirm`，390 / 键盘 / Esc / focus）——**进行中**。
- [ ] S2 Registry DTO + legacy 迁移（registry agent，按 §6 契约）。
- [ ] S3 Laya 安装 / health（安装子任务，按 §7 前半契约）。
- [ ] S4 实际操作测试 + API 诊断（benchmark 子任务，按 §6.5 / §7 契约）。
- [ ] S5 UI 接真实 API（去 fixture 开关）。
- [ ] S6 电脑设置快速 / 生图统一到 registry（每机独立偏好、默认 off、主模型 fallback）。

## 契约交付给主协调（registry / Laya / benchmark 子任务）

见 `docs/design/model-settings-unified.md`：
- §6 最小 metadata DTO + `/api/model-services*` 接口。
- §6.5 实际操作测试 `ActualTaskTestDto` + `/api/actual-task-test/*`（优先项）。
- §7 Laya `LocalRuntimeDto` / `LocalHealthDto` / `ApiDiagnosticDto` + `/api/model-services/:id/local*`。
- §8 平台支持矩阵（Windows ARM = unsupported，明示不假成功）。

## 边界

- 不改 shared credential backend / `secrets.ts` / SDK 钥匙串实现；不引入明文；不重置用户配置。
- 测试先强制 tempdata（内存 `CredentialStore`，`test/setup.ts` 隔离 `5a4614f` 已含）；不跑真实 API 收费 / 桌面 VM / App 安装。
- 只做专项 typecheck / build / UI 测试。
- 未 push / 未 tag / 未打包 / 未装真机。
