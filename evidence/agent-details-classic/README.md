# 助理设置 classic：真实构建与回归证据

2026-10-18。基线 `6c2381cfef93fc0084635f7bc185737665008c60`，用户批准居中64px头像、单行文字分类的完整八页设计。本目录只记录候选源代码与真实临时服务/浏览器验证；公开版仍 beta.32，未打包、未安装或重启用户 App。

批准范围和保存/作用域契约见 [设计](../../docs/design/agent-details-classic.md)，修复历史和交接见 [实施记录](../../progress-snapshots/agent-details-classic.md)。原型63项不计入产品检查。

## 各轮与适用范围

- `functional1/`、`visual1–5/`、`members1/`、`recovery1/`、`limits1/`：实现过程的历史。早期通过不代表最后源码；visual1–4、limits1 的失败保留，不用后续通过覆盖。
- `functional2/`、`visual6/`、`members2/`、`limits2/`：final2 同一次冻结源码上的成功证据。类型、55项纯检查、Web构建、8组功能、155组布局、8组成员和limits夹具检查通过。组数互有重叠，不相加；155组是布局检查分组，不是155个独立业务能力。
- `recovery2/`：原七组通过后，[6]发现产品摘要在另一个字段保存中遮住已有保存失败；`failure.png` 与失败日志保留。主修摘要的保存中/失败并列，并给[6]加入真实PUT暂停闸门。
- `recovery3/`：final3 新构建上的10组异步恢复检查全部通过，含字段错误共存、独立重试和跨模型页挂起写入/读取顺序。沿用原三张截图。
- `functional3/`：final3前七组通过，390主题切换后即时几何断言失败。失败截图在正常落定后的视口内；主使用已有 `waitStable` 等动画自然结束与几何稳定，仍保留原宽度/边界/子控件断言。
- `functional4/`：等待稳定后的功能复跑八组通过，exit0，43.763s；syntax/diff exit0，0.201s，source/test及dist前后不变，无owned残留。

逐项exit/耗时、source/test与构建指纹见 `verification.json` 和 `logs/classic-final{2,3,4}-results.json`。**最后审图后对上限读取失败误列保存失败做了一行源码修正，晚于final3构建/final4，尚未重建重验。** 用户要求快速收尾提交后停止；现有通过记录不覆盖此最后一行。原始日志见本目录 `logs/`；保留历史失败，不声称最终源码全过。

## 真实与夹具边界

所有服务使用本次独占临时DATA/WORKSPACE/HOME/TMPDIR、`packages/server/test/launch-memory.ts` 内存凭据、Mock/offline。浏览器使用 `browserEnv` 保留原生Chrome启动环境和独立headless配置，不接用户Chrome/profile。只清本轮拥有的进程组和临时目录。

功能/成员的模型、思考、Fast和资料（含实际图片上传）经临时HTTP真实保存、GET读回/刷新。恢复脚本路由仅注入失败或延迟，成功保存通过真实 `route.continue`，没有伪造成功响应。图像服务注册使用loopback占位地址，不生成图片或调用付费服务。

布局脚本的记忆新增、同库编辑、跨库迁移及文件上传/预览/下载走真实HTTP；文件交付清单是只读夹具。任务状态、主机状态/权限/暂停、助理电脑/桌面状态为明确夹具，未启动任务、模型或真实driver。limits脚本的每助理GET/PUT是前端夹具；旧全局默认来自临时DB；真实上限持久化另由recovery覆盖。

## 实图核对范围

主会话核对 `visual6` 的完整App概览/模型、其余六页、群专属信息、280更多/当前分类、390覆盖面板、glass/noir/warm/pixel精选明暗与DIY截图。64px居中头像、单行导航、长名换行、资料固定保存栏、搜索图标/边界、记忆作用域、文件分组/长名、电脑权限与暂停范围在可见区域可读。390覆盖面板底色阻隔底层聊天文字。

`03-computer-460-pane.png` 实际捕获工作区路径与uploads目录；280主题图中工作区下方没有完全捕获，不声称审过。红色图片和白色1px上传头像为测试内容，不是用户产物或头像渲染故障。截图审查只覆盖捕获区域，不等于用户审美接受或安装App验收。

## 未覆盖

未跑全量 `npm test` / legacy全量E2E，未验物理手机/WebKit、安装App、跨平台真实电脑/系统TCC、真实模型任务/技能产物质量、付费Fast的加速和计费。没有改服务器/Pi SDK/依赖，也没有新tag、打包、安装或重启。
