# 交接文档（HANDOFF）

> 最后更新：2026-10-13。给接手的开发者 / bot：先读这一页，再按需查 [DESIGN.md](DESIGN.md)（完整设计，章节号下面会引用）。

## 1. 这是什么

Pi Assistant：基于 [Pi](https://github.com/earendil-works/pi) 的本地私人助理。本机服务（`packages/server`，Node 22）+ 唯一界面（`apps/web`，React PWA，电脑 / 手机共用）+ 桌面程序（`apps/tray`，Tauri 2：原生窗口 + 托盘 + 悬浮条，内置 Node 和服务端）。手机通过内置 Cloudflare 隧道远程使用。界面文字是中文（`apps/web/src/i18n.ts` 管英文翻译）。

## 2. 现状

| 部分 | 状态 | 参考 |
|---|---|---|
| Phase 1：本地服务、PWA、流式聊天、审批、后台任务、崩溃续跑、隧道 + 配对 | ✅ 完成，e2e 覆盖 | DESIGN §13 |
| Phase 2：记忆（basic + Hindsight）、技能、定时任务、MCP、Pi 扩展包 | ✅ 完成 | §5.8–5.10、§5.19、§5.20 |
| Phase 3：助理电脑（Docker 桌面 + 实时画面）、浏览器自动化、操作这台电脑（权限档位）、飞书 / 钉钉 / 企业微信 / 邮箱 / Gmail、微信 ClawBot、主动性引擎 | ✅ 大部分完成 | §14 |
| 安装包 | ✅ v0.1.0-beta.4 已发布（mac arm64 / x64、Windows），**未签名** | §5.2 |
| 界面打磨（原生窗口、自定义勾选框、「?」帮助、上下文圆环、统一下载状态、完全权限确认框、悬浮条） | ✅ 2026-10-12 合入 main | §16、§5.19.2 |
| 助理电脑自带虚拟机（Lima / WSL2，不要求装 Docker） | 🚧 第 1 步通用部分 ✅；**第 2 步 macOS（Lima + vz + containerd）✅ 已合入 main，等真 Mac 验证**；Windows（WSL2）/ Linux 服务器版未开始 | §15.2 |
| 共用中转远程访问（Paseo 式） | ⏸ 用户决定暂缓 | §15.1 |
| Linux 服务器版（一条命令安装、一次性设置码、主人设备） | 📝 已确认方案，排在助理电脑之后 | §15.2 讨论 |

### 已实现但没在真机上验证过
- **macOS 助理电脑虚拟机（Lima vz）**：真实开机只能在真 Mac 上测（托管 macOS CI 没有嵌套虚拟化；这台开发机的 KVM 也开不了 qemu 虚拟机）。已验证：固定的 4 个下载文件摘要（真实下载核对）、生成的配置通过真实 `limactl validate`（Linux 版 limactl）、假 limactl + 真 Docker 的完整生命周期测试。真 Mac 验证步骤见下面「macOS 助理电脑真机测试」。
- Cloudflare 命名隧道公网连通、Rendezvous Worker 部署、Web Push 真机推送、微信真实扫码。
- 原生主窗口 / 透明悬浮条：Linux 上 `cargo check` 通过，**macOS / Windows 真机没测**（悬浮条透明在 macOS 依赖 `macOSPrivateApi`，Windows WebView2 透明需要实际看效果）。
- 统一下载状态里的 Hindsight 运行环境 / 向量模型进度是“量目录大小 ÷ 估计值”，真实下载时百分比可能不准（字节类下载 cloudflared / uv / Cua / 微信 / 重排序模型是准确的）。

## 3. 构建 / 测试 / 发版

```bash
# Node 22.19+
npm ci --ignore-scripts
npm run dev              # Mock 模型启动 http://127.0.0.1:8787（不花钱）
npm run typecheck        # 服务端 + 网页
npm test                 # 服务端单测（~100 个，约 1 分钟）
npm run e2e              # Playwright 端到端（需要 Chrome：CHROME=/path/to/chrome），约 10 分钟，截图写到 docs/screenshots，结果写 RESULTS.md
E2E_ONLY='正则' npm run e2e   # 只跑匹配的步骤（调试）
npm run check:pi         # Pi 升级兼容检查
```

桌面程序（需要 Rust ≥ 1.90；Linux 另需 `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev`）：见 `apps/tray/README.md`。

**发版**：改好后在 main 上打 tag `v0.1.0-beta.N` 并 push → `.github/workflows/release.yml` 在 macos-14 / macos-13 / windows 上构建并上传到 GitHub Release（自动更新签名用仓库 secrets `TAURI_SIGNING_PRIVATE_KEY`）。**只有用户要求时才打 tag。**

**提交习惯**：中文提交信息，一行写清楚做了什么和为什么（参考 `git log`）；截图单独一个提交（“截图：…（编号）+ 全量 e2e 结果”）。不要 force-push 共享分支。

### macOS 助理电脑真机测试（第 2 步）
1. 装 main 打出来的安装包（或源码 `npm run dev`），macOS 13+，Apple 芯片或 Intel 都要测；**不需要装 Docker**。
2. 设置 › 助理电脑：打开「给助理安装电脑」，运行方式保持“自带运行时（推荐）”→ 应显示“macOS 自带虚拟机（Lima）”。观察进度：先下载虚拟机组件（≈650 MB，0–40%）→ 第一次开机安装容器引擎（1–3 分钟）→ 下载桌面镜像。中途断网 / 退出 App 再开，应接着下而不是从头下。
3. 打开某个助理的「电脑」标签 → 自动开机 → 看到桌面画面；让助理打开浏览器访问一个网站。
4. 再开第二个助理的电脑：几秒内开机（共用同一台虚拟机）。
5. 两个都点关机 → 设置里虚拟机显示“已关机”，活动监视器里 `com.apple.Virtualization.VirtualMachine` 进程消失、内存回收。
6. 再开机：之前登录过的网站仍是登录状态。
7. 合上盖子睡眠几分钟再打开，继续用电脑标签（应能自动恢复，必要时自动重启虚拟机）。
8. 退出 App 后再打开：之前的虚拟机能继续用；退出后约半分钟虚拟机应自己关掉。
9. 关闭开关 → “删除虚拟机和镜像” → `~/.pia-vm` 和 数据目录/vm 都被删掉；用户自己的 `~/.lima`、Docker Desktop 完全没被碰。
有问题时请带上：`~/.pia-vm/pia-desktop/ha.stderr.log`、`serial*.log`，以及 设置 › 助理电脑 里显示的错误。

## 4. 分支

| 分支 | 用途 | 状态 |
|---|---|---|
| `main` | 发布分支 | beta.4 + 侧栏菜单修复 + 界面打磨 |
| `wip/lima-backend` | 第 2 步 macOS Lima 后端 | 已合入 main |
| `wip/assistant-computer-vm` | 助理电脑自带虚拟机运行时 | 另一位开发者在做（`packages/server/src/desktop.ts`、`desktop/*`、`packages/sandbox-desktop`、设置 › 助理电脑）。镜像下载目前用自己的进度（`desktop/image.ts`，按镜像层计数，显示在 设置 › 助理电脑）。**待办**：把镜像 / limactl / rootfs 下载也登记到统一下载管理器——`registerDownload({ id: "desktop-image", group: "助理电脑", installed, start })`，下载过程包 `trackDownload`（层进度用 `p.bytes(done, total)` 或 `p.detail("第 3/12 层")`），这样「下载与组件」页也能看到（DESIGN §5.19.2） |
| `ui-polish` | 2026-10-12 界面打磨 | 已合入 main |

## 5. 代码地图（最常改的地方）

- 服务端入口 `packages/server/src/main.ts`，HTTP 路由全部在 `http.ts`（`localOnly` = 只允许本机）。
- Pi 只通过 `packages/server/src/pi-adapter/` 使用（升级 Pi 时只看这里）。
- 统一下载：`packages/server/src/downloads.ts` + `apps/web/src/components/Downloads.tsx`。
- 助理电脑：`desktop.ts`（开关机、端口、截图）、`desktop/backend.ts`（后端选择）、`desktop/lima.ts`（macOS 虚拟机：下载 / 配置 / 开关机 / 保护）、`desktop/names.ts`（容器名硬性保护）、`downloads.ts` 的 `downloadFile`（大文件断点续传 + 摘要校验）。
- Hindsight：`packages/server/src/memory/hindsight/`（sidecar 安装/启动、provider 账本+同步队列、settings 三模型）。
- 操作这台电脑：`host-control.ts`（服务端）、`HostControl.tsx`（设置 + 输入框旁档位按钮）、`HostFloatBar.tsx`（悬浮条页面）、`apps/tray/src-tauri/src/main.rs`（悬浮条窗口）。
- 通用 UI 组件：`apps/web/src/components/ui.tsx`（Button / Modal / Badge / Input / **Help**「?」气泡 / **useConfirm** 确认框）；主题 `apps/web/src/themes/*.css`（勾选框、开关 `.pa-switch`、帮助气泡、下载条样式在 `app.css` 末尾）。
- 输入框工具栏：`Chat.tsx`（`ContextRing` 上下文圆环、`ModelPicker`、`ThinkingPicker`、`HostTierPill`）。

## 6. 未解决 / 已知问题

- 安装包没有签名：macOS 首次要右键打开，Windows 有 SmartScreen 提示（§5.2）。
- macOS 沙箱（系统沙箱档）没做；稳定地址只做了命名隧道。
- 远程 Hindsight 换不同维度的向量模型需要对方实例自己迁移（本机模式已自动处理，见 §5.19.1）。
- MCP 服务器经 `npx` 首次下载、没有进度显示（npm 自己下载，拿不到字节进度）。
- 界面文字精简是逐页做的：设置页小节说明都已收进「?」，其他页面如果还觉得字多，按同样方式用 `<Help>` 处理。

## 7. 下一步（按用户确认的顺序）

1. 助理电脑自带虚拟机：通用部分 ✅ → Mac（Lima）✅ 待真机验证 → Windows（WSL2）→ Linux 服务器版（§15.2）。
2. 每完成一步发一个 beta 版本，告诉用户能测什么。
3. Linux 服务器版：一次性设置码 + 主人设备，`deploy/` 里的服务器部署文件补全。

- 2026-10-13：助理电脑「开机后同一轮可用」和「首张截图空白」已修好（见 DESIGN §16.1）。调试时设 `PIA_DEBUG_COMPUTER=1` 可看到 computer_open 各阶段日志。真实 Docker 的 e2e：`E2E_DESKTOP=1 PIA_DESKTOP_IMAGE=pi-assistant/desktop:dev npm run e2e`（42 步全过）。
