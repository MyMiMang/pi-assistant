# 交接文档（HANDOFF）

> 当前公开版本 **v0.1.0-beta.18**（用户已更新确认）；剩余功能在独立发布树验收中，用户已授权直接提交推送打包，本轮仅 macOS arm64。接手前先读根目录 [AGENTS.md](../AGENTS.md)（规则和流程），再读本页（进度），然后看 [ARCHITECTURE.md](ARCHITECTURE.md)（组件）和 [DESIGN.md](DESIGN.md)（完整设计，下面写的 § 是它的章节号）。

## 1. 这是什么

Pi Assistant 是基于 [Pi](https://github.com/earendil-works/pi) SDK 的本地私人助理，由这几部分组成：
- 本机服务 `packages/server`（Node 22）
- 唯一的界面 `apps/web`（React PWA，电脑和手机共用）
- 桌面程序 `apps/tray`（Tauri 2：托盘、自动更新、悬浮条、桌宠，内置 Node 和服务端）
- Linux 服务器版

手机通过内置的 Cloudflare 隧道远程使用。界面文字是中文。用户只通过安装包的自动更新来测试。

## 2. 进度（按版本）

本轮续接：发布树 `3a44fc0` 保留 beta.18 权限免审批基线，原 beta.15 + WIP 树未 reset、未覆盖。已精选合入图片全屏、模型删除（原生 confirm 改现有确认框）、子代理默认 10 / 持久 FIFO / 重启会话续跑、Tauri 外链。图片桌面/手机专项全部通过；模型 8 项单测与添加/取消/失败/重试删除 UI 链路通过；子代理 14 项 + 渠道 5 项、真实进程重启冒烟通过。UI 入口精简与容器宽度适配已在发布树复核：8 组场景全过，子代理专项 e2e 全过，受影响 types/build 通过。原生 Tauri 外链待 Mac CI 编译和安装冒烟，不能以网页测试代替原生测试。

CI 已增加 `mac-arm64/all` 范围，tag 按 `.github/release-scope.json` 固定本轮仅 arm64；跳过 Windows/Linux/Intel，publish needs 明确容许计划内 skipped、要求 build 和 mac-smoke 成功；资产/latest.json 的平台、签名与包名校验失败保持草稿。静态 3 项测试与全部 shell 语法通过；CI 提交 8764c2a 已推 main，手动仅 Mac 演练 Actions 38581168432 进行中（https://github.com/MyMiMang/pi-assistant/actions/runs/38581168432）。尚未打新 tag；beta.19 说明已准备，发布前再次核对远端空闲号。macOS 系统授权保留因缺 Developer ID 证书明确阻塞，诊断报告保留，不宣称修复，不安装用户 App。


2026-10-15 发布流程**暂缓 Intel Mac**（用户：『intel每次打包很久，下次不要打包他，等后期完全开发再带上』）：`.github/workflows/release.yml` 的桌面构建矩阵改为由 `prepare` 按 `BUILD_INTEL` 动态组装，默认只含 mac arm64 + Windows（加 Linux x64/arm64 两个 job，共 **4 个构建任务**），Intel x64 默认跳过。恢复方式二选一：手动运行 workflow 勾选 `build_intel`，或设仓库变量 `BUILD_INTEL=true`（Settings › Secrets and variables › Actions › Variables）。联动改动：`mac-smoke` 的 Intel dmg 挂载检查、`publish` 的 `x64.dmg` 资产断言都加了 `BUILD_INTEL` 条件，Windows / Linux / latest.json 依赖不因 Intel 缺失而阻塞；`publish` 新增守护——未构建 Intel 时若 `latest.json` 仍含 `darwin-x86_64` 则报错停在草稿，避免 Intel 用户被错误引到 arm 包（跳过时该字段自然缺失，Intel 老用户只停更）。文档（INSTALL / README 平台表、AGENTS、DESIGN CI 说明、ROADMAP）同步改掉「5 个平台」表述。本次只动发布流程与相关文档，未改产品代码、不触发新构建；**进行中的 beta.18（tag `v0.1.0-beta.18`，run 38567460857）用的是改动前的 workflow，照旧 5 平台构建，不受影响**。验证：release.yml YAML 解析通过、矩阵组装脚本用 `BUILD_INTEL=false/true` 两种取值跑出预期 JSON、`bash -n` 无语法错误；未跑产品测试、未另行打包。

2026-10-15 用户纠正权限定义（**已实现，未打包，beta.18 候选**）：『不是完全权限那就得全部都不用审批啊』——档位是“完全权限”（开启 + 允许该助理 + 未暂停，即 `hostFileAccess` 为真）时，**应用层不再创建任何审批请求**，包括硬性保护清单命中的动作（关机、删除、改系统设置等）。实现：`requests.ts` 的 `approval()` 是所有应用层审批的唯一入口（email / connectors / delivery / routines / skills / browser / ext-computer / ext-approval 都经它），在那里按 `hostFileAccess(agentId)` 直接放行、不写卡片（提问 `ask_user` 不受影响）；`ext-approval` 的 `evaluate()` 在 full 下对非 deny 一律 allow、`hardGuard` 命中时不再请求；`ext-computer` 的硬性保护在本机档位 full（`approvals = none`）下不再请求（助理电脑 / 只看 / 限定 / 信任仍照旧）；系统提示与设置页文案同步改掉“受保护操作仍会问你”。**保留的 deny / 阻断**：凭据 / 密钥路径直接 deny、暂停 / 降权 / 关闭（`hostFileAccess` 每次求值立刻变假）、`observe` 输入工具隐藏、宿主系统权限弹窗、网站登录 / 验证码（`request_handoff`）、心跳任务不能执行需批准的操作。注意：`hostPlan` 文字变了 → `approvedHash` 变，已开启“操作这台电脑”的用户需在设置页重新确认一次计划。验证：相关单测 65/65（approval / hard-guard / host-control / sandbox-access / pi-compat / channels / proactive / mirror），服务端全量 249 pass（1 个无关失败：`shared-computer.test.ts` 的合并脚本要 GNU tar，macOS BSD tar 不支持 `--skip-old-files`，在未改动的发布树上同样失败），服务端 + 网页 typecheck 通过；未跑 e2e（未改 e2e 断言）。DESIGN §23.2 / 23.5-23.8、ROADMAP、ARCHITECTURE 已同步。

2026-10-14 beta.17 权限误报热修：基于公开 beta.16（4bfd0f9）的独立发布树，只选择性带入 hard-guard、shell-lex 和 hard-guard 测试，其他 UI / 模型 WIP 留待后续。命令按引号、命令位置和实际写入目标判定；修复 grep 危险词、gh --repo 输出日志、git log 格式串、sed 工作区输出、export PATH、复制受保护源到 /tmp、字面 heredoc 正文的误报。未引号 heredoc 的命令替换、喂给 shell 的脚本、sh -c / 反引号 / $(...) 和真实系统写入继续保护。主会话复核补掉自身保护与 stress 文本的全文匹配残留。在发布树独立验证：hard-guard + approval + host-control + sandbox-access **37/37** 通过，服务端与网页 typecheck 通过；未跑全量。发布按五平台构建和安装冒烟通过后自动公开 Latest。


2026-10-14 发版：beta.13 的 Linux 两版、Mac arm64、Windows 已构建成功；Intel Mac 在 `bundle_dmg.sh` 运行约 16 分钟后失败，重试仍卡在此步骤，已取消（[run 38500745136](https://github.com/MyMiMang/pi-assistant/actions/runs/38500745136)）。上游 tauri-action 默认将 `TAURI_BUNDLER_DMG_IGNORE_CI` 设为 true，强制 Finder 排版；显式设为 false 恢复 bundler CI 模式，并给两次打包加 `--verbose`。参照 [上游问题 1091](https://github.com/tauri-apps/tauri-action/issues/1091)，这是对相同失败症状的兼容处理；beta.13 的简略日志不足以确认具体子命令。以 beta.14 重新构建验证，旧 tag 不移动、旧草稿不公开。YAML 解析和 CLI 参数检查通过，未重跑产品全量测试。

2026-10-14 Intel Mac 打包改法：beta.14（[run 38503909614](https://github.com/MyMiMang/pi-assistant/actions/runs/38503909614)）上面的兼容处理无效，Intel Mac 两次 `tauri build` 各约 20 分钟后失败，其余平台全部成功，草稿未公开。beta.9 起公开版就缺 x64.dmg / x64 更新包。现改为：macOS 只用 `--bundles app` 让 Tauri 出 .app + .app.tar.gz/.sig（Tauri CLI 2.12.2 源码确认：构建 app 目标即生成更新包，latest.json 的 darwin 项不受影响），dmg 由单独步骤用 `hdiutil create`（失败重试 3 次 + verify）打成 Tauri 同名 `Pi.Assistant_<版本>_<x64|aarch64>.dmg` 传进草稿；删掉 continue-on-error/重试/XProtect/`TAURI_BUNDLER_DMG_IGNORE_CI` 等旧补丁；mac-smoke 额外挂载检查 Intel dmg（含 x86_64 二进制和更新包）。先推 release-dryrun 演练验证，不打 tag。

2026-10-14 发 beta.15（用户说「打包」）：基于 94b78a6 + 本说明提交，内容同 beta.13/14（子代理、用量、组队选模型等）+ Intel Mac 打包修复。演练 [run 38508018735](https://github.com/MyMiMang/pi-assistant/actions/runs/38508018735) 全部通过。beta.13/14 的草稿不公开、tag 不动。

2026-10-15 权限需求实现（**已完成，未打包**）：用户否掉“本地项目目录白名单”方案，要求把“完全权限”做成**用户主机上文件/命令/桌面的统一权限**，完全权限下日常命令自动放行、受保护系统动作仍明确批准，并要求可维护、权限判断集中、不新增框架。实现：`host-control.ts` 新增唯一判定 `hostFileAccess(agentId)`（full + 已开启 + 允许该助理 + 未暂停，每次调用求值）；`ext-sandbox` / `ext-approval` / `runtime`（系统提示、`deliver_file`、hostpc 浏览器上传下载、识图）统一调用；`initHostAccessWatch()` 在 `host.changed` 时中止正在跑的主会话/子代理/后台任务；Docker 偏好下 full 的 bash 改在主机跑（本机执行后端经 pi-adapter 注入，扩展不直接 import Pi）、非 full 仍进容器。普通 bash（npm/which/ls/git…）full 下自动放行，凭据路径仍拒绝，硬性保护清单仍每次明确批准。DESIGN §23 已由“设计稿”改为“已实现”并删掉过时的“docker 恒判否”。相关单测（host-control / approval / sandbox-access / hard-guard）全过。

2026-10-15 发 beta.16（用户说「打包」）：基于 50d64c3 + 权限实现 + 本说明，**只含权限相关文件**（ext-approval / ext-sandbox / ext-computer / shared hard-guard、server 的 host-control / runtime / pi-adapter / files / vision-ext / http / main、HostControl、相关测试与 DESIGN/ROADMAP/HANDOFF），未验收的图片查看（ImageViewer / App / Attachments / Markdown / InfoPane）、发送快捷键与子代理卡片改动**不带入**本次发布，留待后续。在独立 worktree（`release-permissions`，基于 origin/main）核验：服务端 + 网页 typecheck 通过、受影响单测 31/31 通过。


| 版本 | 主要内容 |
|---|---|
| ≤ beta.6 | Phase 1–3 基础：流式聊天、审批、后台任务、隧道 + 配对、记忆（basic / Hindsight）、技能、定时、MCP、助理电脑（Lima / WSL2 / Docker，共用电脑）、浏览器、操作这台电脑（权限档位）、飞书 / 钉钉 / 企业微信 / 邮箱 / 微信 ClawBot、主动性、Linux 服务器版 |
| beta.7 | 界面打磨、窄屏适配、多处修复 |
| beta.8 | 更新流程重做（进度、错误原因、设置 › 关于与更新）；操作记录从界面去掉、日志加上限；窄处文字收成图标；手机不再横向晃动 |
| beta.9 | 助理电脑镜像 0.1.3（修 Apple 芯片开机即退出）；模型列表重做并接入 models.dev；「操作你的电脑」提示只在真正操作时出现；README 重写，加第三方组件清单 |
| beta.10 | 助理群聊（管理者派活、一句话建群、群专属助理）；群附件和附件真正交给模型（看图 / 识图模型兜底 / 文档文字提取）；渠道原生图片和文件；群聊审批转发到渠道；思考内容可折叠；图片生成；cua 浏览器和桌面控制；桌宠；聊天居中等手机修复 |

| beta.11 | **修 Windows 打开就是「127.0.0.1 拒绝连接」**：托盘程序拿到的安装目录是 `\\?\C:\...` 原样路径，Node 解析入口时报 `EISDIR: lstat 'C:'` 立刻退出（beta.8 起所有 Windows 版本都有，CI 里用真实安装包复现），`main.rs` 的 `plain_path()` 转回普通路径；服务日志落盘（`startup.rs`）；就绪前主窗口显示自带启动页 `apps/tray/ui/startup.html`，失败时显示原因、日志尾部、重试 / 复制诊断信息 / 打开日志文件夹；8787 被占用自动换 8788…8796（记在配置目录 `port.txt`）；新增 `windows-smoke.yml`（静默装到中文 + 空格目录、启动托盘、查 `/api/system/public`），发版改成先草稿、Windows/mac 冒烟通过才公开（见 DESIGN「CI 构建」）；发版演练（release-dryrun 分支，run 38415435058）：5 个构建、mac-smoke、Windows 安装到中文路径后启动托盘都通过，草稿已自动删除；修 Windows 上 cua-driver 种子复制失败（Node `cpSync` 复制目录在 Windows 上报 `EIO, Access is denied`，用户电脑上实测复现，改为逐文件复制到临时目录再改名 + 重试，`config.ts` `copySeed`） |
| beta.12 | 工作途中插话（Pi steer，下一个工具边界送达，消息显示送达状态）；整条说「停」立即全部停下（含等待中的审批），单聊 / 群聊 / 渠道通用（DESIGN §20）；Mock 模型修正：插话只在打断多步任务时特殊回应，群聊只按最新【用户】发言匹配（修 e2e 里后续群聊步骤被误判成“慢慢数”） |

| main（组队选模型 + 用量，未打包） | **组队选模型 + 用量系统**（DESIGN §22）：建群时服务端按角色需求从已配置模型里打分挑选并写理由，卡片下拉按适合程度排序、带价格档；设置 › 模型 › 模型擅长 可改标签；每次模型调用记一行用量（含读写缓存、推理），按当时价格算费用并存价格快照，自定义单价 / 官方价打折，未知价「—」，人民币显示（汇率可改）；设置 › 用量（今天 / 7 天 / 30 天、按模型 / 助理 / 群、每日柱状图、缓存命中率与省下）；每条回复用量、群聊近 30 天费用；明细 90 天后按天汇总。models.dev 快照加推理 / 工具调用 / 价格（约 490 KB） |
| ↳ 进度 | 2026-10-14 修复 e2e 对历史用量的错误假设：价格行按 `mock/echo` 定位；给 Mock 补价只重算其未知价格，其他服务（包括已删除服务）的历史调用保留。针对性回归「自定义模型服务 + 组队选模型」通过，用量单测 7/7、两边 typecheck 通过。按用户最新要求停止完整 e2e，不再重复全量。已启动的服务端单测最终 225 通过、10 跳过、1 失败：macOS BSD tar 不支持共用电脑合并测试的 `--skip-old-files`（与本次改动无关，未改）。桌宠 17/17、Rendezvous 2/2 通过。真实 Key 验证和 §22.5 缺口仍保留。 |
| main（后台子代理，未打包） | DESIGN §21 第一版：主会话用 `spawn_subagent` 派独立 Pi 会话，立即继续聊天；`subagent_message` 转发补充、`subagent_stop` 停止；每助理并发 3、只一层；设置中跟随 / 自动清单 / 固定模型及助理覆盖。聊天卡片和只读过程面板，主会话统一处理审批；终态与通知事件落库、3 分钟停滞 / 恢复、60 分钟最长运行（可改）、重启标 lost / 重新派；用量带 subagent_id 归属原助理。相关单测 32/32、渠道单测 5/5（确认子代理步骤不外发），两边 typecheck 通过；专项 `node e2e/subagents.mjs` 通过（继续聊、详情、补充转发、审批、停止、模型错误、重启、模型设置、手机布局、群聊），截图 97–98。真实模型的派活 / 核验 / 路由质量和外部渠道真账号仍待实测。 |
| main（子代理会话分页，未打包） | 按用户确认的 Paseo 交互：子代理图标 → 选择任务 → 独立聊天分页，默认不自动开页；主 / 子会话切换保留草稿和滚动，关闭分页不停止任务。消息展示抽到 `ChatMessages.tsx` 共用气泡、思考、工具步骤、文件与用量；保留纯思考消息。子窗口可直接发消息（运行中 steer、只停止当前子代理）；完成后用落库的 `session_file` 接着聊，续聊重新计时、仍受并发 3 限制、每轮完成仍通知主会话。子代理单测 6/6、渠道 5/5、两端 typecheck 与网页构建通过；专项 `node e2e/subagents.mjs` 通过（含完成后 / 重启后上下文续聊、群聊），分页追加验证 `E2E_UI_ONLY=1 node e2e/subagents.mjs` 通过（默认不开页、图标选择、分页切换 / 草稿 / 关闭、直接消息、手机布局）。截图 97、99。未跑全量，真实 API Key 事项仍待验证。 |
| main（模型菜单修复，未打包） | 聊天模型旁的思考强度：补齐自定义模型推理能力、旧配置启动回填，模型列表随设置变化刷新；图片生成列表按接口输出模态 / models.dev 图片输出标记 / 已知生成模型系列识别，不把识图模型当生成模型，不再提供“显示全部”混杂列表。模型快照增加图片输出标记（8），缓存升 v4。19 项相关单测、两端 typecheck、专项 `node e2e/model-capabilities.mjs` 通过（不刷新新增中转、桌面 / 手机思考强度、图片模型过滤、手动别名）。 |
| main（未打包） | **工作途中插话**：助理干活时随时能发消息，在下一个工具边界用 Pi steer 送达（之前是排到整轮做完），消息下显示「已送达正在进行的任务」；整条说「停 / 别做了 / stop」立刻全部停下（含命令、电脑操作、等待中的审批）；1:1、群聊、渠道都适用（DESIGN §20） |

所有功能都有单测和 e2e（Mock 模型）。beta.10 发布前在 main 上全部通过：`npm test`、`npm run e2e`（114 步）、`node e2e/pet.mjs`。

## 3. 已验证 vs 需要真机验证

**只在 CI / 模拟环境里验证过的，需要真机或真实账号：**
- **用户电脑的 cua 浏览器和桌面控制**：Mac（Chrome、信任 / 完全权限）和 Windows（Chrome / Edge）。详细检查项见第 8 节「用户电脑：完全接管与 CDP 浏览器」。
- **助理电脑**：Mac 上的 Lima 虚拟机、Windows 上的 WSL2（托管 CI 没有嵌套虚拟化），还有共用电脑和第二块屏幕。步骤见第 8 节。Apple 芯片开机已在用户的 Mac 上验证过（镜像 0.1.3）。
- **渠道真实账号**：飞书、钉钉、企业微信自建应用和智能机器人、微信 ClawBot 扫码。要看原生图片 / 文件收发，以及群聊审批卡片在渠道里点按钮和文字回复是否都能用。测试时用的是模拟平台。
- **图片生成**：要用真实 Key 测（OpenAI 兼容、百炼、方舟、Gemini、xAI）。测试时用的是模拟服务。
- **识图模型兜底、真实视觉模型收图**：Mock 模型只确认了收到几张图片。
- **思考内容的流式显示**：真实推理模型（DeepSeek、Qwen 等）的 `<think>` 流式拆分，以及半截标签的情况。
- **桌宠**：Mac 和 Windows 上要确认窗口透明（没有白底或黑底，也没有阴影框）、点击穿透、拖动、记住位置、全屏和切换桌面时还在、孵化效果（§19）。
- **HEIC 图片**：只有 macOS 能用 `sips` 转换；Windows 和 Linux 上助理只会收到一句说明，需要真机确认 iPhone 照片的体验。
- **应用更新**：Mac 和 Windows 上从 beta.8 / 9 更新到 beta.10，看进度显示和失败提示。从 beta.7 或更早升级时，旧的更新逻辑可能看起来没反应。
- **用量与费用**：真实服务返回的读 / 写缓存和推理 token 是否齐全（DeepSeek、百炼、火山、中转站经 Pi 返回的字段各不相同），算出来的费用和各家账单是否对得上；国内模型在 models.dev 里的价格是否齐全。
- **组队选模型**：真实模型会不会按要求填 `needs`，挑出来的模型是否合理（Mock 只按脚本）。
- **工作途中插话**：真实模型下的回应是否简短、换方向 / 停下判断是否准（Mock 模型只按脚本回复）；cua 电脑操作被中止时是否立即停（Mock 下只验证了 bash）。
- **其他**：Cloudflare 命名隧道公网连通、Web Push 真机推送、悬浮条透明（`macOSPrivateApi` / WebView2）。

## 4. 已知问题 / 限制
- **Windows 日志位置**：托盘和服务日志在 `%LOCALAPPDATA%\com.piassistant.app\logs\server.log`（超过 5MB 轮转为 `server.old.log`）；数据目录 `%APPDATA%\Pi Assistant`。macOS：`~/Library/Logs/com.piassistant.app/server.log`。
- 端口被占改用 8788… 时，网页的本地偏好（布局、语言，存在浏览器 localStorage，按端口区分）会回到默认；本机访问不需要登录，所以不会掉登录。端口记在配置目录 `port.txt`，之后一直用同一个。
- 安装包**没有签名**：macOS 第一次打开要右键选「打开」，Windows 会有 SmartScreen 提示（§5.2）。
- 群聊：复制群专属助理时不会复制它工作区里的文件。管理者派活做得好不好，取决于用的是什么模型。
- 附件：单个文件上限 100MB；文档摘录最多约 2 万 token；扫描版 PDF 不做 OCR。
- cua-driver 还固定在 0.34.1（上游已经出了 0.35.x），升级前要重新核对 BROWSER.md、WORKFLOW.md 和工具参数格式。
- macOS 系统沙箱档没做。MCP 服务器经 npx 第一次下载时没有字节进度。
- Hindsight 运行环境 / 向量模型的下载百分比是估算的。远程 Hindsight 换不同维度的向量模型时，要对方实例自己迁移。
- 共用中转远程访问（Paseo 式）用户决定暂缓（§15.1）。

## 5. 待用户决定 / 下一步
需求、计划和待决定事项的完整清单见 [ROADMAP.md](ROADMAP.md)。
- **后台子代理第一版已实现（main，未打包）**：主会话聊天、子代理后台干活、可查看过程、复用能力画像选模型。设计与实现见 DESIGN §21；真实模型与渠道真账号待验证。
- **许可证**：建议用 MIT，等用户确认（现在 README 写的是「保留所有权利」，仓库里没有 LICENSE 文件）。
- **代码签名**：Apple Developer ID 公证、Windows 代码签名证书，都要用户提供账号或证书。
- 下一步：等用户实测 beta.10 的反馈 → 修一批 → 用户说「打包」再出下一个 beta。候选：cua-driver 升级到 0.35.x；群里复制助理时带上工作区文件；在 Windows 上转换 HEIC；扫描 PDF 的 OCR。

## 6. 构建 / 测试 / 发版

```bash
# Node 22.19+
npm ci --ignore-scripts
npm run dev              # Mock 模型启动 http://127.0.0.1:8787（不花钱）
npm run typecheck        # 服务端 + 网页
npm test                 # 服务端单测（200+ 个，约 3 分钟）
npm run e2e              # Playwright 端到端（需要 Chrome：CHROME=/path/to/chrome），约 25 分钟（110+ 步），截图写到 docs/screenshots，结果写 RESULTS.md
E2E_ONLY='正则' npm run e2e   # 只跑匹配的步骤（调试）
node e2e/pet.mjs         # 桌宠 e2e
npm run check:pi         # Pi 升级兼容检查
```

桌面程序（需要 Rust ≥ 1.90；Linux 另需 `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev`）：见 `apps/tray/README.md`。

**发版**：改好后在 main 上打 tag `v0.1.0-beta.N` 并 push → `.github/workflows/release.yml` **默认构建 4 个任务**（mac arm64 / Windows / Linux x64 / Linux arm64；macOS 只让 Tauri 出 .app + 更新包，dmg 由 hdiutil 单独打——别再改回 Tauri 的 dmg 目标，Intel runner 上 bundle_dmg.sh 会失败）。**Intel Mac（x86_64）默认跳过**：耗时很久且长期失败（见 ROADMAP「暂缓」），需要时手动运行 workflow 勾选 `build_intel` 或设仓库变量 `BUILD_INTEL=true` 恢复第 5 个任务；跳过时 `latest.json` 不含 `darwin-x86_64`，Intel 老用户只停更不会被分到 arm 包（publish 有守护）。同时写 `docs/release-notes/v0.1.0-beta.N.md`（中文，给用户看）；构建结果并上传到 GitHub Release（自动更新签名用仓库 secrets `TAURI_SIGNING_PRIVATE_KEY`）。测试版 tag 也发布为**正式 latest 版本**（不是 pre-release），否则 `releases/latest/download/latest.json` 404，自动更新失效；`wsl-rootfs-v*` 例外（pre-release、不设 latest）。**只有用户要求时才打 tag。**

**提交习惯**：中文提交信息，一行写清楚做了什么和为什么（参考 `git log`）；截图单独一个提交（“截图：…（编号）+ 全量 e2e 结果”）。不要 force-push 共享分支。

## 7. 代码地图（最常改的地方）

- 服务端入口 `packages/server/src/main.ts`，HTTP 路由全部在 `http.ts`（`localOnly` = 只允许本机）。
- Pi 只通过 `packages/server/src/pi-adapter/` 使用（升级 Pi 时只看这里）。
- 统一下载：`packages/server/src/downloads.ts` + `apps/web/src/components/Downloads.tsx`。
- 助理电脑：`desktop.ts`（开关机、端口、截图、共用电脑 / 屏幕 / 合并）、`desktop/computers.ts`（哪个助理用哪台电脑、主屏幕争用，纯逻辑）、`packages/sandbox-desktop/pia-screen`（容器里的屏幕管理）、`pia-cua-mcp`（cua 中继）、`desktop/backend.ts`（后端选择）、`desktop/lima.ts`（macOS 虚拟机：下载 / 配置 / 开关机 / 保护）、`desktop/names.ts`（容器名硬性保护）、`downloads.ts` 的 `downloadFile`（大文件断点续传 + 摘要校验）。
- Hindsight：`packages/server/src/memory/hindsight/`（sidecar 安装/启动、provider 账本+同步队列、settings 三模型）。
- 操作这台电脑：`host-control.ts`（服务端）、`HostControl.tsx`（设置 + 输入框旁档位按钮）、`HostFloatBar.tsx`（悬浮条页面）、`apps/tray/src-tauri/src/main.rs`（悬浮条窗口）。
- 通用 UI 组件：`apps/web/src/components/ui.tsx`（Button / Modal / Badge / Input / **Help**「?」气泡 / **useConfirm** 确认框）；主题 `apps/web/src/themes/*.css`（勾选框、开关 `.pa-switch`、帮助气泡、下载条样式在 `app.css` 末尾）。
- 助理群聊：`packages/server/src/rooms/logic.ts`（@ 解析、发言规则、上限、增量注入，纯逻辑）、`rooms/index.ts`（建群/成员/调度/停止/继续/重启恢复、群规则与 `room_assign` / `room_propose_member` / `propose_room` 工具）、`rooms/copy.ts`（复制到我的助理）；界面 `RoomChat.tsx`（群聊页、@ 补全、新建群、群设置、删群）、`RoomCards.tsx`（提议卡片、群专属助理操作）。Mock 模型里 `roomReply` 是 e2e 用的脚本（“派给X”“循环”“慢慢”“加个成员”“组个团队”）。设计见 DESIGN §17。
- 桌宠：`packages/server/src/pet/`（状态、宠物包、孵化接口）、`apps/web/src/pet/`（`PetWindow.tsx` 是 /pet 页面，`hatch.ts` 负责去背景和拼图，`zip.ts`）、`components/PetSettings.tsx`、`apps/tray/src-tauri/src/pet.rs`（透明窗口、点击穿透、拖动、记住位置）。内置宠物改动后跑 `python3 scripts/pets/gen-presets.py --preview /tmp/pet-previews` 重新生成，自带格子校验。设计见 DESIGN §19。
- 输入框工具栏：`Chat.tsx`（`ContextRing` 上下文圆环、`ModelPicker`、`ThinkingPicker`、`HostTierPill`）。
- 附件：`files.ts`（上传、群附件 `saveRoomUpload` / `materializeFor`）、`attachments.ts`（图片 / 文档 → 模型输入）、`vision.ts` + `vision-ext.ts`（识图模型兜底、`look_at_image`）；界面 `Attachments.tsx`（`useAttachUploader` / `AttachTray` / `AttachButton`，单聊和群聊共用）。
- 渠道：`channels/index.ts`（入站、镜像、审批卡片、群聊卡片转发 `forwardRoomCard`）、`channels/media.ts` / `caps.ts`（各渠道能力与原生图片 / 文件）、`thinking.ts`（拆出思考内容）。
- 图片生成：`image-gen/`（providers / routes / extension），界面 `ImageModels.tsx`。
- 后台子代理：`subagents.ts`（状态、模型选择、事件、看门狗）、`subagent-routes.ts`（接口及子窗口直聊）、`runtime.ts`（独立 Pi 会话 / 续聊与主会话通知）、`ext-delivery`（派活 / 补充 / 停止工具）；界面 `Subagents.tsx`、`App.tsx` / `store.ts`（会话分页）、`ChatMessages.tsx`（共用消息展示）；专项测试 `e2e/subagents.mjs`。
- 用量与组队选模型：`usage/`（`prices.ts` 价格解析与费用计算、`index.ts` 记录 / 汇总 / 90 天滚动、`routes.ts` 接口）、`model-profile.ts`（擅长标签与打分，纯函数）、`rooms/model-pick.ts`；界面 `Usage.tsx`、`ModelStrengths.tsx`、`usage-fmt.ts`。改价格格式要同时改 `model-db.ts` 和 `scripts/gen-model-db.mjs`。

## 8. 真机测试步骤

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

### Windows 助理电脑真机测试（第 3 步）
需要：Windows 10 2004+ 或 Windows 11（**家庭版、专业版各测一次**），x64；最好一台**还没装过 WSL** 的电脑和一台已经装了 WSL + Docker Desktop + 自己的 Ubuntu 发行版的电脑。
1. 装 main 打出来的安装包（或源码 `npm run dev`）。
2. 设置 › 助理电脑：打开「给助理安装电脑」，运行方式“自带运行时（推荐）”→ 应显示 Windows 的 WSL2。
3. 没装 WSL 的电脑：应显示「安装 WSL」按钮 → 点击 → 弹一次 UAC → 同意 → 等完成 → 显示“需要重启电脑”。再测一次点「否」：应提示“已取消管理员授权”。重启后回到设置，状态应变成可用。
4. 下载 rootfs（≈94 MB）：「下载与组件」页能看到进度；中途断网 / 退出 App 再开，应接着下。（仓库已公开，Release 是主下载源，GHCR 公开包是备用源）
5. 打开某个助理的「电脑」标签 → 自动 `wsl --import` + 开机 → 看到桌面；`wsl -l -v` 里出现 `PiAssistant-Desktop`（VERSION 2），**用户自己的发行版状态不变**。
6. 再开第二个助理：两个桌面同时可用（host 网络，各自端口）。让助理用浏览器访问网站。
7. 两个都关机 → `wsl -l -v` 里 PiAssistant-Desktop 变成 Stopped（Docker Desktop、自己的 Ubuntu 不受影响，没有被 `--shutdown`）；`vmmem` 内存回收（所有发行版都停了时）。
8. 再开机：之前的登录状态还在。退出 App：约半分钟内发行版停掉。
9. 发行版里看不到 Windows 文件：`wsl -d PiAssistant-Desktop -u root --exec ls /mnt` 为空。
10. 关闭开关 → 「删除虚拟机和镜像」→ `wsl -l` 里没有 PiAssistant-Desktop，`%LOCALAPPDATA%\Pi Assistant\wsl` 被删除。
11. BIOS 关闭虚拟化的电脑（如果有）：应显示中文原因“没有开启硬件虚拟化”。
有问题时请带上：设置 › 助理电脑 显示的错误、`wsl --status`、`wsl -l -v` 的输出、`%APPDATA%\Pi Assistant` 下的日志。

### 共用助理电脑真机测试（§15.4，任何平台）
1. 从旧版升级：之前每个助理各有电脑、登录过网站的，升级后这些助理应自动是“单独的电脑”，登录状态还在；设置 › 助理电脑 的「共用电脑」列表里能看到它们，可以「合并进共用电脑」。
2. 新建两个助理：「电脑」标签都显示“共用电脑（N 个助理）”，同一个画面。
3. 在助理甲里登录一个网站（例如让它打开网页并接管扫码登录），再让助理乙打开同一个网站：应该已经是登录状态。
4. 同时让两个助理做需要操作桌面的事：第二个应自动换到自己的屏幕并告诉你；「电脑」标签上方的屏幕按钮可以切换去看另一块屏幕。
5. 给某个助理打开「使用单独的电脑」（助理设置里）：下一条消息起它用自己的电脑，看不到共用的登录状态；关掉后数据保留，可以合并。
6. 合并：单独电脑里的文件出现在共用电脑里；共用电脑原来的登录状态不变，单独电脑的浏览器数据放在 `~/旧电脑-<助理名>/`。
7. 都不用时共用电脑按“空闲自动关机”关掉；再开机登录状态还在。
8. Windows（WSL host 网络）和 Mac（Lima）上重复 2–4，确认第二块屏幕能看到画面。

### Linux 服务器版
- 打包：`npm run build && node scripts/package-linux.mjs` → `dist-linux/pi-assistant-<版本>-linux-<arch>.tar.gz`（+ .sha256）。
- 本地测安装脚本（干净 systemd 容器）：`docker run -d --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw -v $PWD/dist-linux:/pkg:ro <装了 systemd 和 libpam-systemd 的 debian:12 镜像> /sbin/init`，然后 `sh deploy/linux/install.sh --file /pkg/….tar.gz`。
- Docker：`docker compose -f deploy/compose.yaml up -d --build`。
- 服务器模式开关：`PIA_HOST`、`PIA_HEADLESS`、`PIA_TRUST_LOOPBACK`、`PIA_SETUP_CHECK_MS`（设置码检查间隔）、`PIA_CLI_HINT`（日志里提示的命令）。命令行实现 `packages/server/src/cli.ts`，设置码 `setup-code.ts`，主人设备 `auth.ts`（`isOwnerDevice` / `setOwner` / `resetOwners`）。

### 用户电脑：完全接管与 CDP 浏览器（DESIGN §14.6.0 / §14.6.1）：需要真机验证
- **Mac（Chrome，信任 / 完全权限）**：
  - 用户的 Chrome 开着、已经登录 → 让助理搜一张图。
  - 我们这层不弹卡片，但可能出现 Chrome 自己的“允许远程调试”提示。
  - 之后 browser_navigate / semantic_v2 / browser_type / dom_event 点击都能用，登录状态还在，Chrome 没有重启。
  - 任务结束后，chrome://inspect/#remote-debugging 的开关应该已经关回去。
  - 同时检查 Chrome 144 以上的自动连接（auto-connect）路径。
- **Mac 完全权限的桌面操作**：微信 / 访达 / 备忘录等任意应用都能 launch_app → get_window_state → click / type_text / hotkey / drag，全程没有卡片；背景送达失败时只对那一个动作切到 foreground；get_desktop_state 能看全屏。
- **Windows（Chrome / Edge）**：trusted 点击应该能在后台送达；守护进程要在交互式桌面里（不是 Session 0）。
- **限定档位**：看不到 browser_* 工具，提示里会让用户调到“信任”。限定档位的清单里本来就没有 drag 和剪贴板，这次没改。
- 测试机的 Docker 不支持 user namespace，所以 isolated_new（cua 自己另开 Chromium）跑不起来；不影响用户电脑上的用法。
- cua-driver 已经出了 0.35.x，这次没升级，还固定在 0.34.1。以后升级时要重新核对 BROWSER.md、WORKFLOW.md 和工具的参数格式。


### 助理电脑镜像 0.1.3（修 Apple 芯片 Mac 开机即退出）
- 现象：Mac（Apple 芯片）点开机报「助理电脑开机后又退出了」，容器 pia-desk-shared 约 150ms 后以 126 退出（日志里的 `_XSERVTransmkdir … euid != 0` 只是无害警告）。
- 根因：Dockerfile 写了 `ARG TARGETARCH=amd64`，默认值盖掉了 buildx 注入的平台值，0.1.2 的 arm64 镜像里装的是 x86-64 的 cua-driver → `Exec format error`；start.sh 的 `wait -n` 把 126 带成容器退出码。Docker e2e 只跑 amd64 所以没发现。
- 修复：`ARG TARGETARCH` 不写默认值；构建时执行 `cua-driver --version` 校验；start.sh 开机前自检并给出中文原因；开机退出的错误带退出码含义。
- 防回归：`scripts/smoke-desktop-nerdctl.sh`（nerdctl-full + 独立 rootful containerd，同 Lima）在 ci.yml（固定 digest）和 desktop-image.yml（新构建）里于 ubuntu-latest + ubuntu-24.04-arm 原生运行器上真实开机。
