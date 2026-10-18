# 发布范围（`release-scope`）：怎么决定 tag 时构建哪些平台

> 事实来源：`.github/release-scope.json`（范围取值）+ `scripts/release-scope.mjs`（推导矩阵、发布前校验）+ `.github/workflows/release.yml`（组装 matrix、冒烟、publish）。
> **当前范围：`all-intel` = Mac arm64 + Intel Mac x64 + Windows x64 + Linux x64/arm64**（2026-10-17 用户明确「全部平台，含 Intel Mac」）。

## 1. 三个取值

| `scope` | 含义 | Mac 矩阵 | Windows | Linux | latest.json 必须含 |
| --- | --- | --- | --- | --- | --- |
| `mac-arm64` | 只发 Apple 芯片 Mac | `macos-14` / aarch64 | 否 | 否 | `darwin-aarch64*` |
| `all` | Mac arm64 + Windows + Linux | arm64 | ✅ `windows-latest` | ✅ x64 + arm64 | 加 `windows-x86_64*`；Linux 独立 tar.gz + sha256 |
| `all-intel` | 上面的全部 **再加 Intel Mac** | arm64 + `macos-15-intel` / x86_64 | ✅ | ✅ | 加 `darwin-x86_64` |

`all-intel` 在 `releasePlan()` 里归一成 `all` 再加 Intel（返回的 `scope` 字段是 `all`，所以「仅 Mac arm64」那套校验不会被误触发）。

## 2. 为什么不用仓库变量

以前 Intel 靠两条补充开关：手动 `workflow_dispatch` 勾 `build_intel`，或仓库变量 `BUILD_INTEL=true`。
**tag 推送（`push: tags: v*`）没有 `inputs`，所以手动勾选对 tag 无效**；只能靠仓库变量，而仓库变量不在 git 里、不可审计、容易忘。
本轮改成在 `release-scope.json` 里显式写 `scope`：**跟着代码走、可 review、tag 触发照样生效**。
`BUILD_INTEL` / `inputs.build_intel` 保留为临时覆盖（例如临时试跑 Intel 而不改文件），但不再是主路径。
（本项目 GitHub 上确实没有配置 `BUILD_INTEL` 变量；不要为了发版去设一个持久的仓库变量。）

## 3. tag 触发时的实际链路

1. `prepare` job：`node scripts/release-scope.mjs`（tag 时 `RELEASE_SCOPE` 为空 → 读 `.github/release-scope.json`），把 `build_matrix` / `scope` / `build_linux` / `build_windows` / `build_intel` 写进 job outputs。
   - `build_matrix` 是含 `{os, target, label}` 的 JSON，直接喂给 `build` job 的 `matrix.include`。
2. `build` job：按矩阵跑 Tauri 构建；mac 的 dmg 用 `hdiutil` 单独打（不用 Tauri 的 `bundle_dmg.sh`，它在 `macos-15-intel` 上反复失败）。产物名 `pi-assistant-<label>`，如 `pi-assistant-macOS-x64`。
3. `linux` job：`if: build_linux == 'true'`，两个 arch 各出一个 tar.gz + sha256。
4. `windows-smoke` job：`if: build_windows == 'true'`（复用 `.github/workflows/windows-smoke.yml`）。
5. `mac-smoke` job：arm64 解压 `.app` 查 `/api`；**当 `build_intel == 'true'` 时**额外下载 `pi-assistant-macOS-x64`、解压并用 `file ... | grep x86_64` 核对确实是 Intel 二进制。
6. `publish` job：`node scripts/release-scope.mjs validate` —— 校验草稿资产与 `latest.json` 的平台/签名是否与推导出的 plan 一致（`all-intel` 时必须存在 `x64.dmg` 与 `darwin-x86_64` 更新项），**不全就拒绝公开**。

## 4. 改范围怎么做

- 改 `.github/release-scope.json` 的 `scope` 一个字段即可（`mac-arm64` / `all` / `all-intel`）。改完跑 `node --test scripts/release-scope.test.mjs`（**不进** `npm test`，要手动跑）。
- 临时覆盖：手动运行 workflow 选 `scope` 下拉（已含 `all-intel`）或勾 `build_intel`；或设仓库变量 `BUILD_INTEL=true`（不推荐长期依赖）。
- 想本地看矩阵（不构建）：`node scripts/release-scope.mjs`。

## 5. 注意与未验

- **Intel 构建慢**：`macos-15-intel` runner 显著慢于 arm64，历史上 `bundle_dmg.sh` 反复失败（已改用 `hdiutil`）。全平台构建由 CI 执行；`all-intel` 已在 beta.29–31 等真实 tag 通过五平台构建、Mac/Windows 安装启动及发布门禁，最近证据见 [beta.31 发布结果](../../progress-snapshots/beta31-ui-hotfix.md#发布结果)。新 tag 仍须重新通过，不沿用旧安装包验收。
- 未构建的平台不会出现在公开的 `latest.json` 里，所以老用户只会「停更」，不会被错误引到别的架构的包（`validate` 也会拦住）。
- 跳过平台时对应的 smoke / publish 条件用 `build_* == 'false' && result == 'skipped'` 放行，见 `scripts/release-scope.test.mjs` 的第三条用例。
