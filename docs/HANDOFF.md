# 交接文档（HANDOFF）

只写**当前状态**，保持一屏到两屏。历史进度在 [history/HANDOFF-2026-10-18.md](history/HANDOFF-2026-10-18.md)，不要再往这里追加长段落。

## 当前状态（2026-10-18）
- 公开版：**v0.1.0-beta.32**（Latest）。main 上之后的改动均**未打包**。
- 未打包改动：助理/群成员详情经典布局（八分类、64px 居中头像、单行标签 + 更多）；群成员改名/改头像后群里即时刷新（`e2e/room-member-rename-ui.mjs`）；代码清理（见下）。
- 清理进度：已完成 主题测试/档位统一、artifacts+精简文档、拆 http.ts（2004→277 行，routes/*）、Pi 边界去 as never、群聊上限与改名刷新修复。未做：Subagents.tsx 简化（会改失败提示行为，待用户确认）、语音/本地ASR/Laya 挪包（牵涉打包，待确认）、拆 runtime/work-items/rooms 与群任务钩子化（见 [群聊协作设计](design/group-collaboration.md)）。

## 交付标准（Definition of Done）
1. `npm run typecheck` 通过。
2. 改动涉及的单测通过；动了服务端就跑 `npm test`（全绿，偶发 `deserialize cloned data` 是测试运行器 IPC 抖动，单独重跑该文件确认）。
3. 跑**与改动相关**的 e2e（`e2e/*.mjs`，用 `fixtures/temp-server.mjs` 的临时数据 + Mock）。不跑全量矩阵、不重复跑多轮。
4. 截图/日志写 `artifacts/`（已 gitignore），不入库；需要给用户看的截图直接发给用户。
5. 在本文件「当前状态」改一两行；ROADMAP 改状态。不写长篇进度记录、不新建 progress-snapshot / evidence 目录。

## 待真机 / 待用户
- 真机：Mac Lima / Windows WSL2 助理电脑、用户电脑 cua 控制、渠道真实账号（飞书/钉钉/企业微信/ClawBot）、Web Push、真实模型 Fast/计费、物理手机 / WebKit。
- 待用户决定：许可证（建议 MIT）、代码签名证书、Paseo 式共用中转（暂缓）。完整清单见 [ROADMAP.md](ROADMAP.md)。

## 已知问题 / 限制
- **Windows 日志位置**：托盘和服务日志在 `%LOCALAPPDATA%\com.piassistant.app\logs\server.log`（超过 5MB 轮转为 `server.old.log`）；数据目录 `%APPDATA%\Pi Assistant`。macOS：`~/Library/Logs/com.piassistant.app/server.log`。
- 端口被占改用 8788… 时，网页的本地偏好（布局、语言，存在浏览器 localStorage，按端口区分）会回到默认；本机访问不需要登录，所以不会掉登录。端口记在配置目录 `port.txt`，之后一直用同一个。
- 安装包**没有签名**：macOS 第一次打开要右键选「打开」，Windows 会有 SmartScreen 提示（§5.2）。
- 群聊：复制群专属助理时不会复制它工作区里的文件。管理者派活做得好不好，取决于用的是什么模型。
- 附件：单个文件上限 100MB；文档摘录最多约 2 万 token；扫描版 PDF 不做 OCR。
- cua-driver 已升级到 0.35.4（host 侧 `third-party.json`；助理电脑镜像 `0.1.4`，digest `sha256:6cc5c119…d54a42`）。0.35.0 是 breaking change，适配点见本文 2026-10-22「CUA 0.34.1 → 0.35.4 适配」一条。以后再升级要重新核对 BROWSER.md、WORKFLOW.md 和工具参数格式。
- macOS 系统沙箱档没做。MCP 服务器经 npx 第一次下载时没有字节进度。
- Hindsight 运行环境 / 向量模型的下载百分比是估算的。远程 Hindsight 换不同维度的向量模型时，要对方实例自己迁移。
- 共用中转远程访问（Paseo 式）用户决定暂缓（§15.1）。


## 代码地图（最常改的地方）

- 服务端入口 `packages/server/src/main.ts`，HTTP 路由全部在 `http.ts`（`localOnly` = 只允许本机）。
- Pi 只通过 `packages/server/src/pi-adapter/` 使用（升级 Pi 时只看这里）。
- 统一下载：`packages/server/src/downloads.ts` + `apps/web/src/components/Downloads.tsx`。
- 助理电脑：`desktop.ts`（开关机、端口、截图、共用电脑 / 屏幕 / 合并）、`desktop/computers.ts`（哪个助理用哪台电脑、主屏幕争用，纯逻辑）、`packages/sandbox-desktop/pia-screen`（容器里的屏幕管理）、`pia-cua-mcp`（cua 中继）、`desktop/backend.ts`（后端选择）、`desktop/lima.ts`（macOS 虚拟机：下载 / 配置 / 开关机 / 保护）、`desktop/names.ts`（容器名硬性保护）、`downloads.ts` 的 `downloadFile`（大文件断点续传 + 摘要校验）。
- Hindsight：`packages/server/src/memory/hindsight/`（sidecar 安装/启动、provider 账本+同步队列、settings 三模型）。
- 操作这台电脑：`host-control.ts`（服务端）、`HostControl.tsx`（设置 + 输入框旁档位按钮）、`HostFloatBar.tsx`（悬浮条页面）、`apps/tray/src-tauri/src/main.rs`（悬浮条窗口）。
- 通用 UI 组件：`apps/web/src/components/ui.tsx`（Button / Modal / Badge / Input / **Help**「?」气泡 / **useConfirm** 确认框）；主题 `apps/web/src/themes/*.css`（勾选框、开关 `.pa-switch`、帮助气泡、下载条样式在 `app.css` 末尾）。
- 助理群聊：`packages/server/src/rooms/logic.ts`（@ 解析、发言规则、上限、增量注入，纯逻辑）、`rooms/index.ts`（建群/成员/调度/停止/继续/重启恢复、群规则与 `room_assign` / `room_propose_member` / `propose_room` 工具）、`rooms/copy.ts`（复制到我的助理）；界面 `RoomChat.tsx`（群聊页、@ 补全、新建群、群设置、删群）、`RoomCards.tsx`（提议卡片、群专属助理操作）。Mock 模型里 `roomReply` 是 e2e 用的脚本（“派给X”“循环”“慢慢”“加个成员”“组个团队”）。设计见 DESIGN §17。
- 桌宠：`packages/server/src/pet/`（状态、宠物包、孵化接口）、`apps/web/src/pet/`（`PetWindow.tsx` 是 /pet 页面，`hatch.ts` 负责去背景和拼图，`zip.ts`）、`components/PetSettings.tsx`、`apps/tray/src-tauri/src/pet.rs`（透明窗口、点击穿透、拖动、记住位置）。内置宠物改动后跑 `python3 scripts/pets/gen-presets.py --preview /tmp/pet-previews` 重新生成，自带格子校验。设计见 DESIGN §19。
- 输入框工具栏：`Chat.tsx`（`ContextRing` 上下文圆环、模型与思考合一的 `ModelPicker`、`HostTierPill`）。
- 附件：`files.ts`（上传、群附件 `saveRoomUpload` / `materializeFor`）、`attachments.ts`（图片 / 文档 → 模型输入）、`vision.ts` + `vision-ext.ts`（识图模型兜底、`look_at_image`）；界面 `Attachments.tsx`（`useAttachUploader` / `AttachTray` / `AttachButton`，单聊和群聊共用）。
- 渠道：`channels/index.ts`（入站、镜像、审批卡片、群聊卡片转发 `forwardRoomCard`）、`channels/media.ts` / `caps.ts`（各渠道能力与原生图片 / 文件）、`thinking.ts`（拆出思考内容）。
- 图片生成：`image-gen/`（providers / routes / extension），界面 `ImageModels.tsx`。
- 后台子代理：`subagents.ts`（状态、模型选择、事件、看门狗）、`subagent-routes.ts`（接口及子窗口直聊）、`runtime.ts`（独立 Pi 会话 / 续聊与主会话通知）、`ext-delivery`（派活 / 补充 / 停止工具）；界面 `Subagents.tsx`、`App.tsx` / `store.ts`（会话分页）、`ChatMessages.tsx`（共用消息展示）；专项测试 `e2e/subagents.mjs`。
- 用量与组队选模型：`usage/`（`prices.ts` 价格解析与费用计算、`index.ts` 记录 / 汇总 / 90 天滚动、`routes.ts` 接口）、`model-profile.ts`（擅长标签与打分，纯函数）、`rooms/model-pick.ts`；界面 `Usage.tsx`、`ModelStrengths.tsx`、`usage-fmt.ts`。改价格格式要同时改 `model-db.ts` 和 `scripts/gen-model-db.mjs`。


## 真机测试步骤
见 [history/HANDOFF-2026-10-18.md](history/HANDOFF-2026-10-18.md) 第 8 节。
