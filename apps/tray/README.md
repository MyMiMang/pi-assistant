# @pi-assistant/tray —— 菜单栏/托盘程序 + 安装包（Tauri 2）

无窗口的托盘程序：安装后开机自启，启动并守护 `pi-assistant-server` sidecar（Node SEA 单文件：Node 运行时 + Pi + 我们的服务），
菜单提供「打开Pi Assistant / 配对手机 / 开机自启 / 检查更新 / 退出」，界面直接用浏览器打开本地 PWA。

状态：**脚手架**（`src-tauri/src/main.rs`、`tauri.conf.json` 已写好），sidecar 打包脚本与签名待 release 流水线实现。
自动更新：Tauri updater 读取 GitHub Releases 的 `latest.json`，新版本（包括升级后的 Pi）静默下载安装。

```bash
npm run build -w @pi-assistant/web
npm run build:sidecar -w @pi-assistant/tray   # 生成 binaries/pi-assistant-server-<triple>、cloudflared-<triple>
npx tauri build                        # 需要 Rust 工具链；macOS 产出 .dmg，Windows 产出 NSIS .exe
```
