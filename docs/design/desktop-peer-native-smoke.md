状态：草稿（Mac / Windows 原生门禁尚未跑）

## 构建与无凭据冒烟

只在隔离构建机作业，准备仓库现有 release 同版本的 Rust stable、Node 22.19+、桌面 sidecar 与应用资源；Mac 需 Xcode Command Line Tools 和对应原生架构，Windows 需 MSVC C++ Build Tools、Windows SDK 与 WebView2。使用已有锁定依赖和正常资源准备步骤（参考 `.github/workflows/release.yml`），不要调用签名上传、发布或自动更新步骤。完成资源准备后，以本机目标运行：

```text
cargo check --locked --manifest-path apps/tray/src-tauri/Cargo.toml --all-targets
cargo test --locked --manifest-path apps/tray/src-tauri/Cargo.toml desktop_peer::tests
node --test packages/server/test/desktop-peer-client.test.mjs
npm run typecheck
```

### 托管机编译验收候选（尚未启动）

`.github/workflows/desktop-peer-native-check.yml` 只响应专用 `desktop-peer-native-acceptance` 分支的 push，并在 job 再核对分支；不对 main、tag 或 PR 触发。它只需只读 checkout，不保留 checkout 凭据，不用仓库 secrets、签名、缓存上传、产物上传或部署。现有仓库全分支扫描仍可能随专用分支 push 独立触发；此配置不改它。不要开 PR 或推 tag。

获准后，由负责人将已审查的准确候选连同此配置放入专用分支，再做一次授权 push（push 本身就是启动）。仓库须允许使用 GitHub 托管机和这两个标准 runner，并确认分钟/预算；只读权限对该作业足够。若不允许推分支，可在两个隔离原生工作目录按工作流步骤执行，无需修改 main。资源复用发布构建的 `npm ci`、`npm run build`、`build-sidecar.mjs --no-bins`：npm 依赖按锁文件，随包 Node 用 `third-party.json` 校验；跳过本验收不需要的附加运行时。托管任务需要能读取公开依赖源；不连生产 Pi。

每台作业上限 **55 分钟**，冷构建估计各 **30–45 分钟**（合计约 60–90 runner 分钟，平台折算和费率另计，未实测）。使用标准 Mac arm64 和 Windows x64 各一台，不跑其它平台。脚本在原生宿主 `cargo check --locked --all-targets` 后，分别编译运行精确 Rust 单测，必须看到每个测试名通过且计数为 1；零项、忽略、失败或子进程异常均失败。这只验证编译和合成状态逻辑，不启动桌面、不访问系统凭据库。原生点击另行验证。

## 需另获授权的隔离原生点击

1. 使用独立系统测试用户和临时 Pi 数据，关闭更新、不得访问日用钥匙串或 Windows 登录资料；仅使用合成聊天。同会话 ID 的 A、B 各预置不同记录。目标 B 使用经批准的测试固定 HTTPS 入口，或只在测试 VM 的系统信任中配置专用 CA；不向发布包加入测试证书或夹具。普通用户的已配置在线固定地址不需要自建证书。该隔离点击不是异地验收。
2. 启动候选桌面 App，确认浏览器/PWA 无原生命令。左上「添加电脑」粘贴 B 本机邀请；预览显示地址和身份，确认之前 B 无申请。B 本机核对并批准，A 领取后打开 B 的聊天。用错误身份、新地址或过期邀请验证不会发送认领或授权请求。
3. 发一次文本，仅 B 保存用户消息和 Mock 回复。断开测试边缘后禁发、恢复不重发；切回 A 保住草稿。重启候选应记住设备；加入第二条测试设备记录，单独忘记 B，不影响第二条。在系统存储不可用时应提示不记住，不落明文或绕到本机。分别验 macOS Keychain 与 Windows Credential Manager。
4. 从未装测试夹具的正式包确认具名 IPC 可用、没有测试传输或信任；在已获授权的测试机上，另做真实独立网络的 Mac→Mac、Windows→Mac。保留不含凭据的日志及截图，不跑发布操作。
