# AGENTS.md：给接手的 AI / 开发者

先读这一页，再看 [docs/HANDOFF.md](docs/HANDOFF.md)（现状、进度、待验证、下一步）、[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（组件与数据流）和 [docs/ROADMAP.md](docs/ROADMAP.md)（需求、计划、待用户决定的事）。完整设计在 [docs/DESIGN.md](docs/DESIGN.md)。

## 这是什么
Pi Assistant：基于 [Pi](https://github.com/earendil-works/pi) SDK 的本地私人助理。功能包括多个助理和助理群聊，每个助理有自己的“助理电脑”（虚拟机里的桌面），也可以按权限档位操作用户自己的电脑。还接入了微信、飞书、钉钉、企业微信、邮箱，支持记忆、技能、定时任务、MCP、图片生成、识图和桌宠。
形态：本机服务（Node 22）+ React PWA（电脑和手机共用一套界面）+ Tauri 桌面程序（托盘、自动更新、悬浮条、桌宠）；另有 Linux 服务器版。界面是中文。

## 仓库地图
| 路径 | 内容 |
|---|---|
| `packages/server` | 本机服务：HTTP/WS（`src/http.ts`），Pi 只经 `src/pi-adapter/` 使用，`runtime.ts` 管助理会话 |
| `packages/ext-*` | Pi 扩展（工具）：approval 审批、sandbox 工作区命令、computer 电脑操作（cua）、browser、connectors 邮箱等、delivery 发文件/提问/后台任务、memory、skills、routines、proactive |
| `packages/sandbox-desktop` | 助理电脑镜像（Debian + Xfce + noVNC + cua-driver），GHCR `ghcr.io/mymimang/pi-assistant-desktop`，固定在 `packages/server/desktop-image.json` |
| `packages/wsl-rootfs` | Windows 助理电脑用的 WSL2 发行版 |
| `packages/shared` | 品牌名等共享常量 |
| `apps/web` | 唯一的界面（PWA） |
| `apps/tray` | Tauri 2 桌面程序（`src-tauri/src/main.rs`、`updater.rs`、`pet.rs`） |
| `apps/rendezvous` | 可选的 Cloudflare Worker（稳定入口） |
| `e2e/` | Playwright 端到端：`run.mjs`（主流程）、`pet.mjs`（桌宠） |
| `deploy/` | Linux 安装脚本、Docker Compose |
| `third-party.json` | 所有外部组件的版本 + SHA256（唯一事实来源） |

## 构建 / 测试
```bash
npm ci --ignore-scripts      # Node 22.19+
npm run dev                  # Mock 模型，http://127.0.0.1:8787，不花钱
npm run typecheck            # 服务端 + 网页
npm test                     # 服务端单测（约 3 分钟）
npm run e2e                  # 全量 e2e（需要 Chrome，CHROME=…；约 25 分钟；截图写 docs/screenshots）
E2E_ONLY='正则' npm run e2e  # 只跑部分步骤
node e2e/pet.mjs             # 桌宠 e2e
```
Mock 模型（`packages/server/src/pi-adapter/mock-provider.ts`）按关键词脚本化回复，e2e 依赖它；改行为时同步改 e2e。

## 发布流程（重要）
- 用户**只通过装好的 App 自动更新**来测试，不跑源码。
- 改动直接推到 `main`（先 `git pull --rebase`），**永远不要 force-push**。
- **只有用户说「打包」时才打 tag**：`v0.1.0-beta.N`，同时写 `docs/release-notes/v0.1.0-beta.N.md`（中文，写给用户看）。
- tag 推上去后 `.github/workflows/release.yml` 会构建 5 个任务：mac arm64、mac x64、Windows、Linux x64、Linux arm64，先传进草稿 Release，Windows / Mac 安装冒烟通过后才公开成 Latest（自动更新读 `latest.json`）。用户中途说停：tag 没推就不推；推了要有 GitHub 登录才能取消（box 上 gh 未登录，见 ROADMAP「工作规则」）。macOS 的 dmg 不用 Tauri 的 bundle_dmg.sh（Intel runner 上反复失败），而是 `--bundles app` 后用 hdiutil 单独打；改发版流程先推 release-dryrun 分支演练。
- 版本号取自 tag，不需要手动改。

## 约定
- **用户一提出新需求或计划，马上记进 [docs/ROADMAP.md](docs/ROADMAP.md)**（写清原话大意和状态），做完再更新状态；进度同步写进 HANDOFF。
- 界面文字是中文，越短越好；需要解释的放进「?」帮助气泡（`apps/web/src/components/ui.tsx` 的 `<Help>`）或悬停提示里。
- 用到开源项目要写进 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，写明版本和许可证。下载的组件还要在 `third-party.json` 里固定版本和摘要。
- 提交信息用中文，一行写清楚做了什么、为什么；截图更新单独提交。
- 有后果的操作（发送、删除、付款、提交）一律走审批（ext-approval / requests.ts）。
- 用户消息在助理忙时走 Pi `steer`（插话），不要改回 `followUp`；停止词判断统一用 `packages/server/src/interject.ts`（DESIGN §20）。
- 新功能要加单测和 e2e，交付前跑 typecheck、单测和相关 e2e。
