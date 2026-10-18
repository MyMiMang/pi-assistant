# 助理/群成员详情功能分类证据

2026-10-18，基线 `9226d13`；实现和定向验收完成，未打包。当前公开版仍为 beta.32，本目录不表示新版本已经发布。详细行为、失败修正与未验范围见 [验收记录](../../progress-snapshots/agent-details-functional.md)。

## 最终结果

Node v24.19.0；服务端与Web类型 exit0；三个前端纯检查文件55/55；Web build exit0；分类UI6组PASS（26.70s）；群成员既有回归8组PASS（30.05s）。分组与历史轮次有重叠，不合成总用例数。当前13个产品文件与最终build时相同，来源/产物摘要在 [source-verification.json](source-verification.json)。

- [两端类型](logs/agent-details-types-final.log)、[55项纯检查](logs/agent-details-pure-final.log)、[最终build](logs/agent-details-build-final.log)。
- [新分类UI最终6组通过](logs/agent-details-ui4.log)：真实临时HTTP保存、资料草稿与字段隔离、分类及旧功能入口、技能/扩展/电脑重试与技能失败回滚、单聊及快捷入口、主题/390/280和键盘。
- [成员回归最终8组通过](logs/agent-details-members-ui4.log)：服务分组/实际档位、创建/加成员/已有助理配置不变、刷新、资料显式保存、保存错误/重试/跟随、390、目录/默认错误与固定档、关闭WS后的元数据/Fast/迟到写入顺序。

复现：先以项目要求的Node版本运行Web build，然后分别执行 `node e2e/agent-details-functional-ui.mjs` 与 `node e2e/room-member-model-settings-ui.mjs`。如需保留截图，设置 `SHOT_DIR` 为独立证据目录。两脚本自行创建临时服务和浏览器，使用内存凭据、Mock/offline；浏览器使用原生启动环境助手。不要并行启动重任务，不需生产App或真实模型。

## 最终截图

主会话逐张看过 `shots/` 的9张最终分类图与 `member-shots/` 的7张最终成员图。截图正文和控件真实可见；长名/明暗主题/390及280没有观察到横向越界；280电脑页路径折行。截图外纵向内容不算图片验收，功能可达以脚本断言补充。电脑未开启/未安装和模拟保存失败是明确fixture，不是用户电脑当前状态。

| 路径 | 内容 |
|---|---|
| [shots/01-overview-desktop.png](shots/01-overview-desktop.png) | 概览摘要与模型跳转 |
| [shots/02-models-desktop.png](shots/02-models-desktop.png) | 主模型、思考、Fast分行，图片和子代理设置 |
| [shots/03-profile-draft.png](shots/03-profile-draft.png) | 资料字段及草稿；不重复模型/电脑配置 |
| [shots/04-capabilities.png](shots/04-capabilities.png) | 技能/扩展，保存失败回滚后的可见错误 |
| [shots/05-models-noir-dark-390.png](shots/05-models-noir-dark-390.png) | 暗夜深色390 |
| [shots/05-models-noir-light-390.png](shots/05-models-noir-light-390.png) | 暗夜浅色390 |
| [shots/05-models-pixel-dark-390.png](shots/05-models-pixel-dark-390.png) | 像素深色390 |
| [shots/05-models-pixel-light-1440.png](shots/05-models-pixel-light-1440.png) | 像素浅色桌面 |
| [shots/06-narrow-pane-280.png](shots/06-narrow-pane-280.png) | 实际280px面板电脑页及工作区 |
| [member-shots/01-proposal-grouped-models.png](member-shots/01-proposal-grouped-models.png) | 已配置服务分组与推荐 |
| [member-shots/02-proposal-thinking-clamp.png](member-shots/02-proposal-thinking-clamp.png) | 显式最大→高的合法降级 |
| [member-shots/03-member-models-immediate.png](member-shots/03-member-models-immediate.png) | 创建后成员模型即时保存 |
| [member-shots/04-member-profile-save.png](member-shots/04-member-profile-save.png) | 资料显式保存成功 |
| [member-shots/05-proposal-mobile-groups.png](member-shots/05-proposal-mobile-groups.png) | 390模型目录 |
| [member-shots/06-proposal-mobile-thinking.png](member-shots/06-proposal-mobile-thinking.png) | 390真实档位弹层及默认中档 |
| [member-shots/07-member-save-error.png](member-shots/07-member-save-error.png) | live保存失败保留原值并可重试 |

## 历史失败证据

`logs/agent-details-ui1–3.log` 和 `logs/agent-details-members-ui1–3.log` 按原结果保留，分别由同名ui4的通过结果覆盖。首轮服务30s未就绪未复现，不能断言模块/资源原因；一次独立诊断4.34s ready，见 [startup-diagnostic.log](startup-diagnostic.log)，其脚本保留供核对。后续失败是测试未等待异步组件/状态、以及把fixture默认medium误写为high；修正没有改变产品源码或超时/重试。

[failures/member-ui2-follow-update.png](failures/member-ui2-follow-update.png)为断言结束后截图，显示随后已出现「跟随默认·中」，不当成断言瞬间状态。[failures/member-ui3-primary-page.png](failures/member-ui3-primary-page.png)只拍到第一页面；实际超时发生在关闭WS的第二页面，该图不证明第二页面状态。原始副本 `member-ui3-primary-page-original.png` 内容相同，保留来源。本次最终member-shots目录只列通过轮次截图。

选中的文本与截图经核对；类型日志仅清理末尾空白行、诊断人工补记的空进程输出标为「无输出」，原文件仍在工作区logs保留，未改检查结果。不提交全局process-before/after日志或合成HOME/环境转储。敏感模式检查是选定文件上的有界检查，不是全仓安全审计。测试收尾关闭本次浏览器、停止临时服务并删除run目录，不清无关进程。

未做全量npm test/全部e2e、物理手机/WebKit、真实账号Fast加速计费、跨平台完整实机及TCC更新验收。此前仅适配导航的旧启动脚本没有在本轮运行。
