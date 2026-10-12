# @pi-assistant/tray —— 菜单栏/托盘程序 + 安装包（Tauri 2）

原生窗口 + 托盘的桌面程序：安装后开机自启，启动并守护服务端（内置 Node 运行时 sidecar + 安装包里的 `app/` 目录），
第一次运行 / 手动打开时弹出原生主窗口（系统 WebView 加载 http://127.0.0.1:8787，不再开浏览器）；关窗口只是隐藏，托盘常驻。
外部链接交给系统默认浏览器。如果 8787 上已经有 Pi Assistant（例如源码安装）在跑，直接复用。

菜单：打开 Pi Assistant / 配对手机 / 暂停（继续）操作这台电脑 / 操作电脑时显示悬浮条 / 操作记录 / 开机自动启动 / 检查更新 / 退出。
助理在操作这台电脑时，屏幕顶部弹出置顶悬浮条（透明无边框窗口，加载本机的 `/hostbar` 页面），一键暂停，× 关闭（状态变化时再出现）。
Linux 上 `cargo check` 需要 rustc ≥ 1.90 和 `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev`。

## 构建

```bash
npm ci && npm run build                          # 网页 + rendezvous
node apps/tray/scripts/build-sidecar.mjs         # binaries/node-<triple> + dist-app（服务端 + 生产依赖 + 网页 + cloudflared/uv/cua-driver）
node scripts/smoke-app.mjs apps/tray/src-tauri/binaries/node-<triple> dist-app   # 用安装包里的 Node 冒烟
cd apps/tray && npx tauri build                  # macOS .dmg / Windows NSIS .exe；需要 Rust
```

正式发布走 `.github/workflows/release.yml`（打 `v*` tag）。自动更新签名：私钥只放在维护者电脑 `~/.config/pi-assistant/tauri-updater.key`，
CI 里设置 secrets `TAURI_SIGNING_PRIVATE_KEY`（私钥文件内容）和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`；公钥在 `tauri.conf.json`。
本地没有私钥时加 `--config src-tauri/tauri.nosign.json`（内容 `{"bundle":{"createUpdaterArtifacts":false}}`）。
