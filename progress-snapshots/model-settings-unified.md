# 统一模型管理 + 本地 Laya + 实际操作测试（进度）

更新时间：2026-10-15（Asia/Shanghai）
执行者：后台子代理（统一模型管理 / UI 主实现）
树：`model-settings-unified`（worktree，基 `hotfix-integration` `b7d33d3`，已 merge `native-dialog-ui-fix` `9554628`）
状态：**本地提交，未 push / 未 tag / 未打包**。等主会话统一发布（仅 mac-arm64；跨平台源码 Laya 必须定义真实支持）。

## 已完成

- [x] 建树 + 合并 `native-dialog-ui-fix`（`9554628`），未丢既有资源 / modalstack / delete / onboarding / isolation / links（合并提交 `35992b1`）。
- [x] 交互架构 + 接口契约：`docs/design/model-settings-unified.md`（已对齐 registry / benchmark 真实契约）。
- [x] **UI 原型（S1）**：`apps/web/src/components/ModelServices.tsx`
  - 统一服务卡片网格（官方 / 自定义 / 生图 / 本地）+ 搜索 + 折叠。
  - 能力多标签（对话 / 识图 / 生图 / 分类器）；推断能力标「未确认」；点「能力」可手动纠正（PUT registry）。
  - 添加服务：`Select` 选官方 / 自定义 / 本地（非原生 select）+ 填地址 Key。
  - 本地 Laya：三阶段进度、cancel / resume / retry / stop、卸载走 `useConfirm`、health 用实际探测 CPU/GPU 标签、平台不支持明示。
  - 实际操作测试：渲染 `FastBenchmarkResult`（不另定义结果结构），先显示 availability / 「尚未运行」/「真实执行未验证（fake ≠ CUA 成功）」，advisory 建议不 hard-disable，云提示计费，选测试电脑（assistant / host）。
  - `apps/web/src/types.ts` 新增 registry / benchmark / Laya 类型（镜像服务端契约）。
  - `Settings.tsx` 的 ModelsTab 挂载统一面板（接口未就绪时可「预览原型」）。
- [x] **e2e 通过**：`e2e/model-services-ui.mjs`（纯前端 fixture，静态 dist + 拦截 /api，不起 main、不碰钥匙串）：
  能力标签/纠正、添加服务、Laya health + 卸载确认、实际操作测试 availability/未验证/advisory、Esc 关弹窗、390 宽不溢出、无原生 dialog —— **通过**。
- [x] 专项验证：`tsc --noEmit -p apps/web` exit 0；`vite build` 通过（2493 模块）。

## 环境记录（构建坑，供后续）

- worktree 构建失败根因：**worktree 缺 `apps/web/node_modules`**（`highlight.js` / `typescript` 装在 workspace 层，不是 symlink 问题）。修复：从主树 `cp -Rc apps/web/node_modules` 到 worktree 后 `npm run build -w @pi-assistant/web` 通过。

## 待做

- [ ] S5 UI 接真实 API（去「预览原型」demo 开关）：registry GET 已可用，等生图迁移 + Laya 安装 + benchmark 真实 fixture。
- [ ] S6 电脑设置快速 / 生图统一到 registry，删除独立 `ImageModelsSection` / `VisionModelPicker` / 快速凭据区。
- [ ] 能力纠正接口 `PUT /api/models/registry/:provider/models/:id/capabilities`（UI 已按此调用，待 registry 落地）。

## 交给主协调的 schema 增量（请转 registry / benchmark / laya owner）

见 `docs/design/model-settings-unified.md` §6.1 / §6.2：
1. `RegistryProvider.kind` 增加 `"local"` + `local: LocalRuntimeDto`。
2. `RegistryModel.imageAdapter`（仅 image）：`{ kind, baseUrl, edit, costNote? }` —— 取代 `imageProviders` / `imageKey:<id>` 两套 key。
3. 生图迁移 `migrateLegacyImageProviders`：凭据唯一（`credentialId===provider.id`），`keyFrom` 只挂到自定义 provider，独立 Key 迁到统一凭据并标 `imageKeyMigrated:<id>`，旧密文保留但运行时不读；幂等不删原数据。
4. 能力纠正 `PUT /api/models/registry/:providerId/models/:modelId/capabilities`。
5. benchmark `POST` body 可选 `target`（assistant / host → `target.prefix`）。

## 边界

- 不改 shared credential backend / `secrets.ts` / SDK 钥匙串实现；不引入明文；不重置用户配置；各自独立 tree。
- 测试先强制 tempdata（内存 `CredentialStore`）；未跑真实 API 收费 / 桌面 VM / App 安装。
- 未 push / 未 tag / 未打包 / 未装真机。
