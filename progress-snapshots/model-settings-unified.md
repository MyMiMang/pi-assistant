# 统一模型管理 + 本地 Laya + 实际操作测试（进度）

更新时间：2026-10-15（Asia/Shanghai）
执行者：后台子代理（统一模型管理 / UI 主实现）
树：`model-settings-unified`（worktree，基 `hotfix-integration` `b7d33d3`，已 merge `native-dialog-ui-fix` `9554628`）
状态：**本地提交，未 push / 未 tag / 未打包**。等主会话统一发布（仅 mac-arm64；跨平台源码 Laya 必须定义真实支持）。

## 已完成

- [x] 建树 + 合并 `native-dialog-ui-fix`（`9554628`），未丢既有资源 / modalstack / delete / onboarding / isolation / links（合并提交 `35992b1`）。
- [x] 交互架构 + 接口契约：`docs/design/model-settings-unified.md`（对齐 registry / benchmark / **Laya 冻结契约**）。
- [x] **UI 原型（S1）**：`apps/web/src/components/ModelServices.tsx`
  - 统一服务卡片网格（官方 / 自定义 / 生图 / 本地）+ 搜索 + 折叠。
  - 能力多标签（对话 / 识图 / 生图 / 分类器）；推断能力标「未确认」；点「能力」手动纠正（`PUT /api/models/registry/:p/models/:m/capabilities`）。
  - 添加服务：`Select` 选官方 / 自定义（非原生 select）+ 填地址 Key；本地 Laya 在管理卡里安装，不在添加对话框。
  - **本地 Laya 管理卡**（按 `local-laya-runtime` 冻结契约 `/api/local-models/laya/*`）：安装 / 取消 / 启动 / 停止 / 更新 / 卸载确认；阶段进度；**health 读实测 `device` / `cpuFallbacks` / `revisions`**（不是 `platform.accelerator`）；`source=local`；**停止后模型显示未就绪、不删条目/配置**；平台不支持置灰 + reason；**明写「尚未在本机实机验证」**；永不显示 token。
  - **实际操作测试**：渲染 `FastBenchmarkResult`（不另定义结果结构），先显示 availability / 「尚未运行」/「真实执行未验证（fake ≠ CUA 成功）」，advisory 建议不 hard-disable，云提示计费，选测试电脑（assistant / host）。
  - `apps/web/src/types.ts`：registry / benchmark / **LayaStatus** 类型（镜像服务端契约）。
  - **默认不渲染**：`/api/models/registry` 未就绪时面板返回 null，保持旧界面（避免影响现有 e2e）；`?unified=1` 预览原型。registry 就绪后自动接管。
- [x] **e2e 通过**：`e2e/model-services-ui.mjs`（纯前端 fixture，静态 dist + 拦截 /api，不起 main、不碰钥匙串）：
  能力标签/纠正、添加服务、**Laya 管理卡（已安装/运行/停止未就绪/卸载确认/未实机验证）**、实际操作测试（availability/尚未运行/未验证/advisory）、Esc、390 宽、无原生 dialog —— **通过**。
- [x] **回归**：`e2e/model-ui.mjs` 全部通过（确认统一面板默认不渲染后不影响既有模型 UI）。
- [x] 专项验证：`tsc --noEmit -p apps/web` exit 0；`vite build` 通过。
- [x] 截图（`screenshots/`，已用识图确认内容）：`1-services-desktop.png` / `2-actual-task-test.png` / `3-services-390.png`。

## 提交

- `35992b1` merge native-dialog-ui-fix
- `f5a7428` 设计文档（一页交互架构 + 契约）
- `140b0cc` UI 原型（第一版）
- `778c7d9` UI 原型对齐 registry/benchmark 契约
- 本轮（待提交）：Laya 冻结契约接线 + 默认隐藏开关 + 截图 + e2e

## 环境记录（构建坑）

- worktree 构建失败根因：**worktree 缺 `apps/web/node_modules`**（`highlight.js` / `typescript` 装在 workspace 层）。修复：从主树 `cp -Rc apps/web/node_modules` 到 worktree 后构建通过。

## 待做

- [ ] S5 UI 接真实 API（去掉默认隐藏开关）：registry GET 可用；等生图迁移（registry）+ Laya 实机 + benchmark 真实 fixture。
- [ ] S6 电脑设置快速 / 生图统一到 registry，删除独立 `ImageModelsSection` / `VisionModelPicker` / 快速凭据区。
- [ ] 能力纠正接口 `PUT /api/models/registry/:provider/models/:id/capabilities`（UI 已按此调用，待 registry 落地）。
- [ ] Laya `WS local-laya.changed`（原型先轮询 1s）。

## 交给主协调的 schema 增量

见 `docs/design/model-settings-unified.md` §6.1 / §6.2：
1. `RegistryProvider.kind` 增加 `"local"`（或用 provider id `local-laya` 识别）。
2. `RegistryModel.imageAdapter`（仅 image）：`{ kind, baseUrl, edit, costNote? }` —— 取代 `imageProviders` / `imageKey:<id>` 两套 key。
3. 生图迁移 `migrateLegacyImageProviders`：凭据唯一（`credentialId===provider.id`），`keyFrom` 只挂到自定义 provider，独立 Key 迁到统一凭据并标 `imageKeyMigrated:<id>`，旧密文保留但运行时不读；幂等不删原数据。
4. 能力纠正 `PUT /api/models/registry/:providerId/models/:modelId/capabilities`。
5. benchmark `POST` body 可选 `target`（assistant / host → `target.prefix`）。

## 边界

- 不改 shared credential backend / `secrets.ts` / SDK 钥匙串实现；不引入明文；不重置用户配置；各自独立 tree。
- 测试先强制 tempdata（内存 `CredentialStore`）；未跑真实 API 收费 / 桌面 VM / App 安装；**Laya 未实机验证**（后端测试 fake / 环回 HTTP）。
- 未 push / 未 tag / 未打包 / 未装真机。
