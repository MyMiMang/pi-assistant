# beta.32 额度与空回复错误可见性

2026-10-18，公开仍beta.31，用户截图显示只有「引用」没有正文，询问是否Codex额度已耗尽，要求失败时直接说明具体原因；未查真实账户，不将该截图单独认定为额度证明。本修复与原beta.32群任务/监督/主动推进/Fast/成员配置/技能用途一起收尾，已获提交更新打包授权，未发布/未安装。

## 已核实的问题与改动

- 既有前端只认status=error；已结束空done/遗留失败形态仍可能只留引用。旧文案混合quota与普通429，还一律建议重发。新增明确额度、临时限流、鉴权、上下文、超时、连接、服务与未知分类；额度只在服务明示时展示，普通429不推断没额度；额度说明等待恢复或换可用模型，不编恢复时间。
- 前端错误主体在气泡内始终可见，服务返回可读信息放可点开的详情，手机也可看；受控字段提取、脱敏与截断。旧空结束消息显示“未收到回复/服务未提供具体原因”；只跳过紧邻工具步骤前的纯工具占位，不因整轮有工具吞掉最终空回答。两内置主题×明暗与390新构建静态UI已通过，主会话看过暗色390及像素浅色桌面：额度已用完、等恢复/换模型、展开英文原文均可见，无空白/越界。
- 适配层新增公开modelErrorMessage受控提取/脱敏、assistant_end的aborted/hasToolCalls语义，errorMessage不会因非error stop丢掉；无start的失败仍能落库。runtime保留失败前已收到的正文/思考、用户停止标interrupted，空最终成功标error/未知；合法tool-only中间不留孤立引用，settled前缺end也收尾。
- 已确认后台tasks.run原来只看promise resolve与aborted：Pi把模型失败记录在message而prompt正常resolve，故可能“后台任务完成，结果空白”。新lastAssistantError只读公开session.messages检查最终结果；失败记failed，卡片和原对话直接程序错误，不额外调用失败模型解释。原异常catch也直接同作用域报错。
- 此修复不宣称截图每一空行都已独立追溯到Codex，也不把空/超时一律说成没额度；无服务原因如实显示未知。不改Pi SDK/node_modules或延长timeout，不增自动重试/更换主模型。

## 主会话实跑

- Node24.19.0，两端typecheck exit0（logs/model-error-combined-typecheck2.log）。
- 新server模型错误5/5（logs/model-error-reporting-main3.log）：受控字段/脱敏、abort/tool-only、适配层→runtime直接事件验证无start的quota/空/正文/停止，真Pi+loopback额度/空最终/部分正文落库，后台额度failed与直接原对话通知/元数据；共预期4真实loopback请求，无额外解释轮。新增直接事件测试首跑因放在顶层初始化await之前触发TDZ，移至fixture初始化后通过，未改产品断言。
- 前端纯16/16（logs/model-error-frontend-main.log），纳入最终Fast/目录/滑块/发布范围共76/76（logs/beta32-pure-final3.log）；前端子代理早先Node26自测仅附加证据，正式采用Node24。
- 16文件合组server192/192（logs/beta32-final-server2.log）通过后主会话补最后无start兜底/SystemMsg中文，增量由上面5项+类型覆盖。新build3（2540modules）和noir/pixel×明暗四组合静态错误UI/390通过（logs/beta32-final-build3.log、beta32-error-static-ui3.log）。
- 两次明确fixture失败保留：首静态新增user缺meta→补接口恒有的meta={}；首次live在error已落库后查不存在GET /api/agents/:id而idle timeout→用既有GET /api/agents按id读取，不放宽idle断言、不延长timeout。
- 真链现已通过 `logs/beta32-error-live-main7.log`：6轮SSE→真实Pi→error落库→刷新后UI分类，desktop/390额度详情可展开、无越界，quota无重试/无额外模型解释。临时限流/超时保留Pi已有backoff，首错后调用公开停止取消等待，再验idle；不宣称这两类自动收尾无重试。主会话两图均看过，确实有中文额度提示与英文原文，不只剩引用。不伪造消息API，不代表真实Codex账户。
- live夹具的每个模型固定一种错误，避免原先把Pi原有rate retry消费下一用例的错误流，diagnostic5保留；按首错停止再验分类，不修改产品重试设置。另有两次冷启动15秒无ready（result4/main6，后者日志只有launch-memory临时目录校验）；服务准备改用与既有任务UI相同的30秒，本轮main7通过，模型请求/错误等待仍15秒，未调整产品timeout/网络设置。冷启动延迟本身未单独定根因，保留日志，不称其已修复。
- t_mvdi9xkgep0mlz 三UI全通过（`logs/beta32-final-three-result8.txt`），主会话看图仍发现一个真实集成问题：技能内部用途推断按宿主规范可无输出/等卡片，却误触新空最终错误。修为宿主`onlyIdle + allowEmpty`仅技能用途内部轮可静默，真实error分支仍优先，user_start立即清标记；直接事件测试补允许空但quota仍显示。不是让所有nudge/后台/用户请求吞空输出。新错误+技能 **19/19** 与两端types通过（`logs/beta32-error-skill-final9.log`、`logs/beta32-types-final9.log`）。
- 主看任务草稿图也发现报错在详情顶端滚出屏，编辑失败错误移到编辑区保存按钮旁、保留草稿，e2e补“模拟保存失败”具体文本断言及拍摄编辑区。新任务390图标题/正文边界已正常。t_mvdiidlehty8g2 最终新build/任务UI/技能UI（新增零错误强断言）/真错误UI **4/4 PASS**（33.7/33.3/22.5/25.9秒），主会话读`evidence/beta32-validation/beta32-final-result9.txt`并核最新图：任务错误、草稿和保存按钮同时可见；技能desktop/390用途三行与三个选项完整，无“未收到回复”误报；真额度desktop/390中文解释与英文详情可见无裁切。真错误恰好6请求，quota无重试，临时rate/timeout公开停止原有backoff后idle。最后只读进程核对无本次e2e/launch-memory残留；无相关变化的Fast/static/boundaries沿用前面有效结果。

## 旧整合验证补正

- t_mvdfc3xjncw6uu确实完成了187server/60pure/typecheck/build，之后work-boundaries UI首阶段失败；没跑后续3UI，未生成汇总。只读核验sa_mvdgvpeemxb57m中把“群不存在”叫偶发并不准确：那是已修fixture复用已删群，改独立群后完整187通过，不是碰运气重跑。
- 边界UI失败根因是Mock探针用整段转录contains取消项，乙的独立task也跑了甲的sleep而没submit，不是产品取消串群。改只看当前assignment标题，严格assert未降级；logs/work-boundaries-ui-main2.log已PASS：实际运行pause防延迟文件、另一群同agent子代理/同群别项不误停、失败甲→乙改派/交付/read验收、详情/列表乱序隔离、>100历史分页与390。evidence/work-boundaries/390历史截图主会话已看，文字/卡片左右边界正常；运行中取消证据来自延迟文件/执行状态断言。

## 仍未验

真实Codex付费账户/额度恢复时间/原截图生产记录，真实模型规划语义/费用/Fast速度，安装版WebKit/物理手机与跨平台完整任务未验；当前全部为隔离内存凭据、临时目录、Mock/loopback，未读生产DB/凭据、未改用户模型、未重启生产。
