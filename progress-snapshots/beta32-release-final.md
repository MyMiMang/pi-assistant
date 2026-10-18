# beta.32 发布收口

## 版本与授权

用户明确“全部弄完就提交更新打包”，本轮包含群成员模型/强度与技能用途、群长期任务、子任务监督/主动推进、请求Fast显示及模型故障可见性。沿用 `.github/release-scope.json` 的 `all-intel` 五平台，草稿→构建→Mac/Windows安装启动冒烟→公开Latest；未授权也不执行自动安装或生产App重启。当前公开仍beta.31；此记录是候选收口，不把本地通过写成已发布。

## 候选行为

- 模型故障由程序直接持久化/显示：明确额度耗尽与临时429分开，鉴权/上下文/网络/超时/服务/未知分别说明，服务没原因不猜，详情可在手机展开且脱敏；保留部分正文/思考及真正停止，无start/空最终不再只留引用。后台prompt正常resolve仍检查最终模型状态，失败记failed并直接原会话提示，不能发空的成功通知或再请求失败模型解释。
- 宿主技能用途内部轮可按规范无输出结束，等待卡片不误报空回复；该例外仅host onlyIdle技能推断，用户新消息清掉，真实服务错误始终优先。技能用途明确后先卡片/idle，同意后原会话查重保存。
- 群任务责任/执行/验收分层、同任务纠正与修订、原群交付读取核验，看板是同数据视图；actor/room/owner/run/revision精确授权，暂停撤队列及实际中止，群停止持久化/仅本群子代理、安全继续不重放started未知，最多3自动执行不被改派/编辑/continue绕过；稳定100后分页与详情/跨群响应隔离。首期主要绑定群回合，background/subagent责任全关联与资源锁未实现。
- 非停止的子代理事件不再要求放弃原目标；持久主动推进回可信原对话，有停止/预算/去重，发现事项不凭猜代用户决策。Fast关闭/default不常驻，保留历史请求/来源与不确定性，不改参数/思考/模型。

## 实测依据

所有本机验证使用Node24.19.0、setup-before-config临时数据/内存credentials、Mock/loopback与Chromium，不查生产库或真实账户，不改SDK/node_modules，不恢复撤下的电脑选择模型。

| 检查 | 结果与口径 | 仓库证据 |
|---|---|---|
| 整合16服务端文件 | 192/192；含25任务、原群、主动推进/子代理/wait/Fast/成员/技能/初版错误/entry映射 | evidence/beta32-validation/beta32-final-server2.log |
| 最后错误/技能增量 | 19/19，覆盖无start、空最终、后台failed/中文元数据、宿主可静默但quota仍显示；与192有重叠不相加 | evidence/beta32-validation/beta32-error-skill-final9.log |
| 前端纯与发布范围 | 76/76；Fast、目录、滑块、消息错误16、release-scope | evidence/beta32-validation/beta32-pure-final3.log |
| 两端类型 | 最后增量exit0 | evidence/beta32-validation/beta32-types-final9.log |
| 群真实安全边界 | PASS：运行中pause阻止20秒命令落文件；别群同agent子代理/本群别项存活；甲失败改派乙/read验收；详情乱序/跨群列表、106历史稳定分页、390 | evidence/beta32-validation/work-boundaries-ui-main2.log |
| 错误静态UI | noir/pixel×明暗四组合PASS，正常/思考/工具中间/旧空/停止/错误分类与详情/390 | evidence/beta32-validation/beta32-error-static-ui3.log |
| Fast真实协议UI | PASS，off/on/off恰好3请求，思考不变、刷新/历史保留、390正文 | evidence/beta32-validation/beta32-fast-ui-final8.log |
| 最后新build/任务/技能/真错误UI | 4/4 PASS，33.7/33.3/22.5/25.9秒；新skill等待无error强断言、保存错误同屏、真错误6请求/刷新/390均过 | evidence/beta32-validation/beta32-final-result9.txt |

主会话已看协议额度desktop/390、静态暗色390/浅色desktop、任务二执行/编辑草稿/看板390/详情390/历史390、Fast关闭正文与技能desktop/390；技能误报与编辑错误滚出屏正是在看图时发现、补修并追加断言。最后六图复核：错误/草稿/保存同屏，技能用途/选项完整且无误报，额度中文与原文真实可见，390任务长文正常换行。runner只读检查无本次e2e/launch-memory残留。

## 保留的失败与局限

原整合边界失败是Mock把整段历史匹配成当前取消任务，已改当前assignment；新静态fixture user漏meta、live查不存在agent GET、rate重试消费下一用例、冷启动15秒ready未到均有日志，未降断言/未重复整组碰运气。live每模型固定错误，临时限流/超时首错后公开abort原有backoff再验idle，quota不重试；fixture准备统一30秒，产品timeout/重试参数没改。冷启动延迟及原供应商timeout根因未确证。

真实模型规划/授权语义/技能文案质量、真实Fast加速计费、真实Codex账户/额度恢复、物理手机/WebKit/跨平台完整任务、TCC升级持久性未验。没有全量npm/e2e、独立全仓secret扫描；主会话发布前对85个变更文本（含选择保留的验收日志，排除原始logs/图片）作有界私钥/常见token模式扫描0命中，结果`evidence/beta32-validation/bounded-sensitive-pattern-check.json`，不等同gitleaks全量通过。既有all-intel发布门禁/签名与Linux校验后续照常核验。

## 发布状态

最终四项与截图均已主核通过。源码/文档/日志提交 `610b50a`，截图单独提交 `a08e041`；正式main干净时先`pull --rebase`，再ff至 `a08e041b4f5d857afe1a62e7dc8b1faa05e0ef7b`，fresh远程仍`885ed08`且无beta.32 tag后，原子推送main与新annotated tag `v0.1.0-beta.32`成功。

[Actions39109851436](https://github.com/MyMiMang/pi-assistant/actions/runs/39109851436)于2026-10-18T08:01:26Z开始，head确认 `a08e041b4f5d857afe1a62e7dc8b1faa05e0ef7b`。all-intel五平台构建、Mac/Windows安装启动、publish和公开资产核验待结果，当前Latest仍beta.31。保持既有门禁与旧tag不动，未自动安装或重启生产。
