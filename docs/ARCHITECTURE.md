# 架构概览

简版说明，细节见 [DESIGN.md](DESIGN.md)（章节号写在括号里）。

```mermaid
flowchart LR
  subgraph 用户设备
    W["网页 / PWA<br/>apps/web"]
    P["手机 PWA"]
    T["桌面程序 Tauri<br/>apps/tray：托盘·更新·悬浮条·桌宠"]
  end
  subgraph 本机服务 packages/server
    H["http.ts / WS<br/>bus 事件"]
    R["runtime.ts<br/>每个助理的 Pi 会话"]
    PI["pi-adapter → Pi SDK<br/>模型 / models.dev 参数"]
    X["ext-* 扩展工具"]
    RM["rooms/ 群聊调度"]
    CH["channels/ 微信·飞书·钉钉·企微"]
    IG["image-gen/ 图片生成"]
    V["vision.ts 识图兜底"]
    AT["attachments.ts 附件→模型输入"]
    DB[("SQLite data.db<br/>+ 工作区 / files")]
  end
  subgraph 助理电脑
    VM["Lima(macOS) / WSL2(Windows) / Docker(Linux)<br/>nerdctl 容器：Xfce + noVNC + cua-driver"]
  end
  HC["用户电脑<br/>cua-driver（host-control.ts）"]
  CF["Cloudflare 隧道"]
  W & T --> H
  P --> CF --> H
  H --> R --> PI
  R --> X
  X --> VM
  X --> HC
  RM --> R
  CH <--> H
  R --> AT & V & IG
  H & R & RM & CH --> DB
```

## 组件
| 组件 | 位置 | 说明 |
|---|---|---|
| 本机服务 | `packages/server` | Node 22 + Hono。`main.ts` 启动，`http.ts` 放全部接口，`bus.ts` 推事件给前端（WS） |
| 助理详情 | `InfoPane.tsx`、`ModelPicker.tsx`、`AgentEditor.tsx` | 私聊/群成员共用八分类；64px头像/单行响应式标签，模型/思考/Fast复用原串行写入；资料独立草稿与版本保护、固定保存/滚动正文；画图/子代理单份状态供摘要与展开区使用，读取/保存/错误分开；能力/任务/记忆/文件/电脑复用原模块（未打包，[功能契约](design/agent-details-functional.md)、[批准视觉](design/agent-details-classic.md)） |
| Pi 集成 | `src/pi-adapter/` | 只有这个目录直接用 Pi SDK（§5.15）；`models.ts` / `model-db.ts` 管模型和 models.dev 参数 |
| 助理运行时 | `src/runtime.ts` | 每个助理（每个对话）一个 Pi AgentSession，挂上扩展工具，把 Pi 事件写成消息（`messages.ts`） |
| 扩展工具 | `packages/ext-*` | 审批闸门、工作区命令、电脑操作、浏览器、连接器、发文件 / 提问 / 后台任务、记忆、技能、定时、主动性 |
| 审批 / 提问 | `src/requests.ts` | 产生卡片消息，等用户在 App 或渠道里回答 |
| 助理电脑 | `src/desktop.ts`、`src/desktop/*`、`packages/sandbox-desktop` | 后端选择（Lima / WSL / Docker），默认所有助理共用一台电脑、每个助理一块屏幕（§15.2、§15.4） |
| 操作用户电脑 | `src/host-control.ts`、`ext-computer` | cua-driver 按权限档位开放工具，用户电脑上的网页走 CDP（§14.6） |
| 群聊 | `src/rooms/` | 管理者调度、@ 规则、上限、增量注入、群附件、建群提议（§17）；单群停止按成员会话收拢，不按agent误停别群 |
| 长期责任 | `src/work-items.ts`、`WorkItems.tsx` | 任务/执行/事件分层，修订与精确群回合绑定；群里交付/核验，看板是同一份数据视图（§17.5）；首期未贯通background/subagent完整责任关联 |
| 主动推进 | `src/proactive.ts`、`subagent-supervision.ts` | 巡检发现与原对话实际执行分开；持久队列、停止与安全恢复；执行done不等于目标验收，notify/wait按事件区分监督与真正停止 |
| 渠道 | `src/channels/` | 消息先写进 App，再镜像到渠道（§14.13）；原生图片 / 文件发送（`media.ts`、`caps.ts`）；审批卡片（含群聊的）转发到绑定的单聊 |
| 附件 | `src/files.ts`、`src/attachments.ts` | 上传存到工作区；图片发给支持看图的模型，否则交给 `vision.ts` 描述；文档提取文字摘录 |
| 图片生成 | `src/image-gen/` | 多家服务商，`generate_image` 工具（§18） |
| 思考内容 | `src/thinking.ts` | 把正文里的 `<think>` 内容拆出来，放到可折叠的思考区 |
| 请求错误 | `pi-adapter` / `runtime.ts`、`message-body.ts` | 错误受控脱敏后落库，空最终/无start也可见；明确额度与临时限流分开，未知原因不猜；后台失败直接原对话通知，无需再调模型（§17.6） |
| 桌宠 | `src/pet/`、`apps/web/src/pet/`、`apps/tray/src-tauri/src/pet.rs` | 透明窗口 + 点击穿透（§19） |
| 远程访问 | `tunnel.ts`、`named-tunnel.ts`、`auth.ts` | cloudflared 隧道 + 设备配对（§5.13） |
| 记忆 | `src/memory/` | basic 或 Hindsight sidecar（§5.19.1） |
| 下载管理 | `src/downloads.ts` | 所有大组件统一显示进度、断点续传、校验 |

## 一条消息的流程
1. 网页 `POST /api/agents/:id/messages`（群聊用 `/api/rooms/:rid/messages`），可以带附件 id。
2. `runtime.send()` / `turn()`：先由 `attachments.ts` 整理附件（图片、文档摘录），再调 Pi `session.prompt(text, {images})`。
3. Pi 流式输出 → `bindSession` 写入 / 更新消息 → `bus` → WS 推给网页，同时由 channels 镜像到渠道。
4. 工具调用经 ext-approval 判断要不要审批 → `requests.ts` 发出卡片 → 用户批准后继续。完全权限档位（`hostFileAccess`）下应用层不弹审批：`requests.approval()` 在唯一入口直接放行（含硬性保护动作）；凭据 deny、暂停 / 降权、系统权限弹窗与验证码不受影响（DESIGN §23.8）。
5. 群聊：`rooms/index.ts` 按规则串行排队，每个成员在群里有一个隐藏对话，轮到它时注入还没看过的群消息和附件路径。长期任务由管理者记录/派活、成员在真实关联回合提交、管理者/用户核验后接受；服务端不依据模型停下或命令exit0判业务完成。

## 存储（数据目录：mac `~/Library/Application Support/Pi Assistant`，Linux 服务器 `/var/lib/pi-assistant`，开发时 `PIA_DATA_DIR`）
- `data.db`（SQLite）：助理、对话、消息、执行任务、请求、文件、群、渠道等（基础表见 `src/db.ts`）；`work-items.ts`维护业务责任/执行/事件三表，`proactive.ts`维护主动推进队列。没有新增模型runner。
- `workspace/<助理>/`：助理的工作区（上传在 `uploads/`，群附件在 `room-files/<群>/`）。
- `files/`：发出去的文件快照；群里用户上传的附件在 `files/rooms/<群>/`。
- `agents/<助理>/`：Pi 会话文件；`credentials.enc` + `master.key`：加密保存的密钥。
- 日志、截图、操作记录都有上限，由 `housekeeping.ts` 定期清理。
