# 助理/群成员详情功能分类验收

2026-10-18；基线 `9226d13`，分支 `agent-details-functional`。功能实现和定向验收完成，未打包；当前公开 Latest 仍为 beta.32（源码 `a08e041`）。不移动已发布 tag，不自动安装或重启用户 App。

用户反馈：点击助理或群成员后详情分类不合理，找不到每个成员的思考强度。单聊和群成员共用 `InfoPane`；配置仍属于助理并在私聊和各群之间共享。此前从安装包 plist 核实用户本机为 beta.31，不能根据仓库中已有控件推断用户已安装它。

## 变化

- 一级概览、模型、资料、能力、任务、记忆、文件、电脑。概览只做摘要和导航；模型页分行显示主模型、思考强度、Fast，保留图片模型和子代理候选池/强度/任务上限。
- 模型/思考仍走原按助理串行写入与迟到响应守卫，Fast 独立保存；保留真实档位、跟随、降级、目录加载失败和重试。加载失败不误报模型协议不支持；概览与模型页对降级使用同一存储值/有效值。
- 资料只显式保存头像、名字、说明、人设；首次进入才建立草稿，切分类保留，换助理重建，保存不发送 model/thinking/fast。
- 能力页保留技能启用与扩展分配；读失败/保存失败独立显示，自动回滚读取不能抹掉保存错误。空技能/空扩展提供已有全局管理入口。
- 任务二级复用后台任务、定时任务、主动跟进；电脑页保留权限、共用/单独电脑、桌面、工作区。侧栏编辑、技能空态、主动菜单直达正确分类，旧内部导航键仍映射。
- 保留自适应更多菜单、所选标签可见与键盘路径；长名、简介和头像配色区可换行。未改服务端、Pi SDK、依赖、请求超时或重试。

设计与文件归属详见 [功能分类设计](../docs/design/agent-details-functional.md)。

## 最终验证

Node v24.19.0；类型、纯检查、build 和浏览器顺序执行。产品源码自最终 build 后未变，后续仅修正浏览器测试就绪与预期；[源码/产物指纹](../evidence/agent-details-functional/source-verification.json)记录13个 Web 文件合成哈希及 `index-D1Z1ng_m.js` 摘要。

| 检查 | 结果 | 证据 |
|---|---|---|
| `npm run typecheck`（服务端与 Web） | exit 0，3.75s | [types-final.log](../evidence/agent-details-functional/logs/agent-details-types-final.log) |
| Fast / 两层模型菜单 / 思考滑块三个纯检查文件 | 55/55，0失败/跳过/取消 | [pure-final.log](../evidence/agent-details-functional/logs/agent-details-pure-final.log) |
| `npm run build -w @pi-assistant/web` | exit 0，6.35s | [build-final.log](../evidence/agent-details-functional/logs/agent-details-build-final.log) |
| `e2e/agent-details-functional-ui.mjs` | exit 0，26.70s，6组PASS | [ui4.log](../evidence/agent-details-functional/logs/agent-details-ui4.log) |
| `e2e/room-member-model-settings-ui.mjs` | exit 0，30.05s，8组PASS | [members-ui4.log](../evidence/agent-details-functional/logs/agent-details-members-ui4.log) |
| 所有改动/新增 E2E `.mjs` 语法及 diff 空白 | 通过；语法检查不等于脚本运行通过 | 提交前本树检查 |

同一组55项不与前轮或 beta.32 的历史计数叠加。6组/8组是脚本输出的检查分组，不冒充14个互不重叠的独立测试用例。

分类UI实际覆盖：群成员模型/思考/Fast的真实临时HTTP保存、七档与独立字段、资料草稿切页/失败恢复/字段隔离、全部分类可达、技能/扩展/电脑加载失败重试、技能保存失败回滚后错误保留、单聊同配置、技能/主动入口直达、四组真实 skin/mode 与桌面/390、280面板和更多菜单键盘路径。

既有群成员回归实际覆盖：创建提议按已配置服务分组与真实档位/合法降级、加入已有助理不改其配置、确认创建和新增成员落库、刷新保留、资料显式保存/失败保留、live保存失败/重试/回跟随、390目录和思考弹层边界、目录/默认错误重试与真正不可调、关闭WS后的原始/有效字段同步、Fast独立、跨成员迟到响应按同助理队列写入。

主会话查看最终分类9图与成员7图：文字/正文真实可见，所选分类可见，明暗主题和长名称未横向越界，280电脑页工作区路径折行；资料、能力、保存错误以及390目录/思考弹层可读。截图在 [证据目录](../evidence/agent-details-functional/README.md)，不将截图外未显示的纵向内容算作已看过。电脑未安装/权限未开启为明确fixture状态，并非生产电脑异常。

## 保留的失败记录与修正

- `agent-details-ui1.log`：服务就绪前30s超时，浏览器尚未启动。独立一次启动诊断4.34s ready，未复现；上次未采样，不断言具体根因。[startup-diagnostic.log](../evidence/agent-details-functional/startup-diagnostic.log)保留事实与限制。后续串行，不扩大产品或夹具就绪上限。
- `ui2.log`：前四组通过后，单聊导航在App快照就绪前误判持久化面板开关，测试自己关掉面板；等待聊天按钮和标签栏后再判断开关。
- `ui3.log`：前四组通过后，即时文字断言读到真实「正在加载…」；改成有界等待实际档位，主题刷新同样等待。`ui4.log`为最终6组通过结果。
- `members-ui1.log`：模型页刚挂载就 `isVisible()`，图片模型异步配置初始为null；改为等待实际图片/子代理组件后再保留可见性断言，同时等待刷新后的档位。
- `members-ui2.log`：已写库为跟随但渲染尚未更新，即时断言仍读到「高」；改为等待「跟随」。[失败现场](../evidence/agent-details-functional/failures/member-ui2-follow-update.png)随后捕捉到真实「跟随默认·中」，不能把截图时点当成断言时点。
- `members-ui3.log`：前七组通过；最后关闭WS组把fixture `thinking: medium` 的跟随预期误写为「高」而超时。改成「跟随·中」并额外断言真实HTTP有效值为 `medium`；保持显式 `max → high` 的独立降级断言。常用/服务分组会各列同一模型，选型定位 `.first()` 点击同一个语义模型，不删分组或行为断言。失败时现在逐页截图；旧该轮只拍主页面，不能代替第二页失败现场。
- `members-ui4.log`：最终8组全部通过。所有失败修正均在测试就绪/定位/预期层，未改产品、模型、超时或增加自动重试。

## 隔离与限制

真实临时HTTP服务、内存凭据、Mock/offline、浏览器独立临时profile；电脑状态用明确API fixture，不操作原生桌面或生产权限。浏览器环境使用现有 `browserEnv()`。依赖复用同基线 `9226d13` 的 integration 树；该树 shared/ext 包无工作区差异，本次未修改这些包。真实Web产物来自本工作树。没有调用付费模型、操作生产数据库/凭据、安装App或接管Chrome9225。

脚本 finally 关闭自己的浏览器、停止临时服务并删除临时run目录；最终新鲜检查仅核本次资源，不清理无关进程。选择的证据日志不含全局进程快照；提交前对选中文本作有界敏感模式检查，不称全仓安全审计。

尚未做本轮全量 npm test/全量e2e、物理手机/WebKit、实际账号Fast加速计费、跨平台完整实机及TCC升级验收。旧e2e有未迁移隔离启动器，只适配导航未运行，不能把语法检查当其运行通过。当前公开beta.32不含本次重排，源码提交或合main也不等于发布。
