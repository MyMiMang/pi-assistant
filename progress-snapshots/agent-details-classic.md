# 原版大头像助理设置实施与验证

状态：2026-10-18，用户已确认第三轮整套设计并授权实施。当前工作树 `agent-details-visual-polish` 基于 `6c2381c`；已实现，按用户最新「快速收尾然后提交…进度和问题」要求整理提交后暂停，未打包。此前按「停止后只汇报状态」暂停；用户指出「有问题不修」后已恢复修复与验证。重复送达的旧任务通知仅作历史证据，不重新执行已经完成的操作。公开 Latest 仍为 beta.32，安装版不因本次源代码变化而更新。

## 批准范围

用户选择「最早大头像、单行标签那版」，看过完整 App 概览/模型图、其余六页联系图和交互 HTML 后回答「确认，按这版实现」。前两轮模型页 A/B 与双行导航均被否决。正式契约见 [原版视觉设计](../docs/design/agent-details-classic.md)，配置语义沿用[功能分类基线](../docs/design/agent-details-functional.md)。

八页共用 InfoPane：64px 居中头像、单行文字标签、自适应更多；资料独立滚动和固定保存；聊天模型/思考/Fast 即时保存，图片/子代理真实摘要与展开；技能扩展、原任务三级、记忆、上传与交付文件、两台电脑复用已有模块。没有新增服务端/SDK/存储协议。

## 主审修正

- Fast 设置页复用共享 FastButton 的 450ms 悬停、键盘聚焦/关闭、错误和风险说明，视觉小开关独立呈现，保留44px命中区；原思考弹层按钮尺寸不变。
- 单行导航的实际间距、More按钮和隐藏测量行统一，计算仍扣除实际内边距；菜单补Home/End与限高滚动。
- 资料保存期间继续输入时，成功响应仅标记本次提交版本；较新的草稿保留未保存状态。卸载后不写回组件，资料PATCH仍不含model/thinking/fast。
- 记忆筛选与选项允许换行；作用范围和status=draft含义不变，不新增晋升操作。
- 图片/子代理初始读取、目录失败、保存失败与摘要真实性另作定向修补；完成情况以最终代码和实跑结果为准。
- 测试通过真实summary展开模型区，不自动跳过默认折叠检查；资料保存/人设/头像使用明确testid/placeholder。settings-subagent迁移为本次独占临时数据和内存凭据；未运行保留固定路径的旧脚本。

## 已实际执行

- Node v24.19.0，`node --import tsx --test e2e/fast-mode-frontend.test.mjs e2e/model-menu-two-level.test.mjs e2e/thinking-slider-frontend.test.mjs`：55/55通过，0失败/跳过/取消，870.97ms，见 `logs/classic-pure1.log`。发生后仅改UI呈现/资料保护和测试，最终验证仍须确认当前源代码。
- `npm run typecheck -w @pi-assistant/server`：exit0，见 `logs/classic-server-types1.log`；本轮没有改服务器。
- 当前变更 `git diff --check` 与已检查的e2e语法通过。实现worker的Web类型自查不替代主会话最终构建。

## 失败与后续验证

- `classic-visual-ui4.log` 在电脑权限文本匹配 `/当前/` 失败；完整设置以选中外观标识档位，「（当前）」只属于紧凑菜单。修正断言后 `classic-visual-ui5.log` 155组布局检查、`classic-members-ui1.log` 八组成员回归通过；它们均早于最后一批修复，不代表当前源码最终验收。
- `classic-recovery-ui1.log` 原七组恢复检查通过；`classic-limits-ui1.log` 在清空覆盖后立刻读取输入框得空字符串。测试现等待默认值与输入框可用同时成立；最终重跑结果另记，不把时序推测当已证根因。
- `logs/classic-final-results.json` 确认前一轮 typecheck exit0（4.42s），纯测试 exit1（0.19s，16项通过，TSX文件加载失败）；后续构建及UI未执行。失败原文为加载 `ThinkingSlider.tsx` 时 `ERR_UNKNOWN_FILE_EXTENSION`，保留原日志。
- 新增恢复脚本[6][7][8]覆盖字段错误独立、思考重试不抹候选池、同助理跨模型页重挂读写顺序。主核发现[7]设置的 `poolPutHoldContinue` 与route读取的 `poolHoldPutContinue` 不符，已改正；语法通过不能替代运行。
- `classic-final2` 依次通过语法/空白、两端类型（4.372s）、显式 `node --import tsx --test` 的55项纯检查（0.513s）、Web构建（7.259s）、功能8组含实际头像上传（30.824s）、布局155组（53.729s）、群成员8组（29.607s）、上限fixture检查（10.346s）。扩充恢复在原七组通过后于[6]失败（exit1，12.814s）：思考写入尚未落定时，候选池失败仍在展开区，但摘要只显示「保存中…」，遮住已有失败。逐项记录在 `logs/classic-final2-results.json`；本次无owned进程组残留。整体diff哈希变化来自主会话同步文档，不用于声称source变更；source/test逐文件指纹另核。
- 主修 `Subagents.tsx` 将摘要pending和错误由互斥改为并列，既有保存失败在另一字段保存中仍提示。恢复[6]增加真实思考PUT挂起闸门，确定性核对pending/错误共存再放行真实保存；[7][8]改用当前 `gates.waiters.has`，避免历史到达次数让相同闸门提前通过。
- `classic-final3` 只重跑改动所影响的类型/新构建/恢复与功能回归，不重复已过且不受摘要一行改动影响的全主题/成员/limitsfixture矩阵。实际结果写 `logs/classic-final3-results.json`，旧 `recovery2/failure.png` 与原日志保留。

## 真实截图核对

主会话已实际查看 `visual6` 的近黑完整App概览/模型、460宽资料/能力/任务/记忆/文件/电脑、群专属信息、280更多与当前项、390覆盖面板、glass暗色/noir暗色/pixel浅色/warm浅色/DIY模型页。可见区域中：64px头像居中、长简介与导航分离；资料保存栏固定且表单未越框；技能搜索图标不压字、错误有红色；记忆作用域与任务状态可读；文件分组与长文件名换行；电脑权限选中外观与全局暂停范围清楚。390覆盖面板不透出底层聊天正文。图片夹具红色小图与上传白色1px头像是测试内容，不能当真实用户产物或空头像问题。

截图只覆盖捕获可见区域；280电脑页工作区下半部未在主题图中完整出现，不声称看过。`functional2` 的模型/资料/能力截图及 `recovery2/failure.png` 亦已核对。自动布局检查与主会话可见区审查不替代用户审美或安装App验收。

## 最后核验与暂停点

- final3：语法/空白exit0（0.279s），typecheck exit0（4.742s），Web build exit0（8.005s），recovery3全部10组exit0（21.482s）；functional3前七组通过后于390主题布局的即时boundingBox断言失败（exit1，16.897s）。源码/测试前后216文件指纹一致，无owned进程残留。
- 功能测试改用现有 `waitStable` 等字体、有限动画自然结束及连续帧几何稳定，保留原边界断言。final4语法/空白exit0（0.201s），functional4八组exit0（43.763s），未超时；source/test及dist前后均一致，无owned残留。此轮没有触发初始越界对照日志；动画时序是针对已知过渡的稳定性修正，不将推测写成失败根因实证。
- 主审恢复截图又发现：上限GET读取失败时，摘要已有「任务上限读取失败」却额外显示「保存失败」。最后将 `poolSaveErr || thinkingSaveErr || limits.err` 改为 `poolSaveErr || thinkingSaveErr || (limits.phase === "ready" && limits.err)`。**此一行产品源码晚于final3构建和final4；尚未重新类型检查/构建/回归。** 此后用户要求快速收尾停止，未扩大验证。
- 接手优先：对上述读取/保存区分增加或确认业务断言，重跑类型/构建与对应恢复用例；必要时补280电脑页屏下区域。不得把现有通过记录当最终一行源码已验，也不得将自动截图当用户审美/安装验收。
- 正式文档、证据索引与源/截图独立提交随本次收尾保存；没有待继续跑的验证任务。后续工作等用户新指令，不自动恢复。

所有浏览器测试只使用owned临时DATA/WORKSPACE/HOME、内存凭据、Mock与原生browserEnv，不启动生产电脑/真实模型、不使用用户Chrome配置或付费服务。离线原型63项通过只证明原型，不能当产品验收。未做新tag/打包/安装/重启，也未做物理手机、WebKit、跨平台真实电脑或真实供应商计费验收。


## 接手核验（2026-10-18 23:30，Asia/Shanghai，box）

- 最后一行源码已重验（单次，不与 final2–4 相加）：typecheck exit0；Web build exit0；recovery 10组 exit0（新增 GET 失败不标保存失败 / PUT 失败仍标保存失败的断言）；functional 8组 exit0；room-member 8组 exit0。
- 服务端单测 1140/1150 过，1 失败为既有主题顺序测试（与本轮无关），9 跳过。
- 280px 电脑页屏下区域仍未补查；安装App、物理手机/WebKit、真实电脑权限未验收。
