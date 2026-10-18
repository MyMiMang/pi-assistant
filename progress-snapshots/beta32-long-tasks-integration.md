# beta.32 扩展整合记录（2026-10-18）

## 当前交付状态

- **beta.32已公开为Latest，2026-10-18 16:29:18（Asia/Shanghai）**。按授权提交源码`610b50a`/截图`a08e041`，正式main先pull再ff，原子push main与新tag `v0.1.0-beta.32`至 `a08e041b4f5d857afe1a62e7dc8b1faa05e0ef7b`。all-intel [Actions39109851436](https://github.com/MyMiMang/pi-assistant/actions/runs/39109851436)五平台、Mac/Windows安装启动及publish成功；主核13资产、六更新别名/签名文件与Linux摘要一致。未自动安装/生产重启，精确证据与未验集中见[最终收口](beta32-release-final.md#发布状态)。
- 整合HEAD `373373c`：前置群模型/技能用途 `5850c11`，任务 `bfc98f8`，监督/主动推进/Fast（源 `2de2470` cherry-pick）。只HANDOFF/ROADMAP顶部冲突，保留两方向，产品源码自动合并后已定向回归。
- `610b50a`收口增量：群停止持久性/安全继续、按真实历史计重试、无start/空最终/后台失败可见、任务乱序分页与新UI断言。见[任务边界末审](work-items-final-boundaries.md)、[错误修复](beta32-error-reporting.md)。

## 主会话审查后产品行为

任务责任与单次执行分开，不另建runner，保留现有群串行。actor绑定group+agent，派活/submit绑定room+owner+run+revision；取消用真实roomId及exact turn撤销内存/DB、scope abort。群stop同步持久停止并pause责任，旧async cleanup不能删新state；仅本群成员对话子代理受影响。继续只重建已证没开始且关联可核的旧queued/cancelled/interrupted执行，started未知交管理者检查，暂停/已验/已取消/改派/新修订不复活。初次执行后最多3次自动重试，按实际run历史计数，continue/edit/room_assign/改派blocked→active不能绕；明确user新授权单列。

看板是同一责任记录的视图。详情/列表请求代次与room key防串台，详情清旧草稿并核ID/room；状态全量筛选；updated_at+id稳定cursor避免同毫秒翻页漏/重。原群用户纠正关联原责任并修订，不要求用户维护第二份任务。

## 已跑与失败修正（不能相加成同一套）

1. 历史原实现run13任务正常成功/纠正UI；原20unit、恢复118server/55pure与Fast真实协议UI均为整合前证据，不能替当前终验。
2. 第一整合runner t_mvdfc3xjncw6uu：两端types、187server/60pure、build通过；边界UI阶段1失败 `other task continues`，之后任务/Fast/技能UI没有跑，未生成汇总。Mock用整段历史contains取消探针，乙独立当前任务也误跑sleep。主会话改只匹配当前assignment标题，失败协调探针同理，strict assert未放宽。
3. 一次必要边界复验 `logs/work-boundaries-ui-main2.log` PASS：正在运行pause阻止20秒命令落文件，B群同agent已running子代理存活、A群另一任务完成；甲实际失败→管理者改派乙→真实交付/read验收；A详情迟到与旧群列表不串；100后追加到106项、不重不漏；390截图。主会话看过 `evidence/work-boundaries/01-page-history-390.png`：历史责任标题/负责人/状态/时间可见，左右不越界；滚动内容顶部部分卡片不当标题裁切缺陷。
4. 新模型错误5项 `logs/model-error-reporting-main3.log` PASS（含公开事件直接喂runtime：无start的quota/空/正文/abort/tool-only），两端types `logs/model-error-combined-typecheck2.log` PASS。
5. 第二整合runner t_mvdhbiqwl4zdgd：16定向文件 **192/192 server**（logs/beta32-final-server2.log，79.8秒）、build PASS（2540modules）。静态错误UI第一个组合因新user fixture没meta访问attachments失败，首错即停；logs/beta32-final-verification-result.txt如实保留。主会话核为测试数据不合接口契约，补默认meta={}，没有改弱断言。之后另补无start和SystemMsg中文分类，故192结果不包含最后这两个小增量，新增5项及types覆盖。
6. 当前 **76/76纯检查** `logs/beta32-pure-final3.log`：Fast/两层目录/滑块/发布范围/消息错误；此前60pure+新增16，不叠加历史55/58。
7. t_mvdhv6xdf9kcpn 的新build3与四组合静态错误UI/390通过，live失败因夹具查不存在单agentGET；改列表读取后另冷启动ready15秒失败。主会话diagnostic复验又发现限流retry消费下一fixture错误，已固定每模型错误并在rate/timeout首错后公开abort原有backoff。`logs/beta32-error-live-main7.log`最终6轮通过，quota无重试、其余分类/刷新可见/idle与390细节均按既有原语验证；仅fixture冷启动等候采用任务UI同样30秒，不改产品请求timeout/重试。失败日志都保留，不能说供应商timeout根因已修。主会话看过新协议desktop/390，额度中文/英文详情可见无越界。
8. t_mvdi9xkgep0mlz 的任务成功纠正、Fast、技能确认三UI通过（`logs/beta32-final-three-result8.txt`，54/22/22秒）；主看四任务图、Fast图及desktop/390技能图后，发现技能正常等卡片下方被新空最终逻辑误报。按宿主技能用途规范只为该onlyIdle内部轮允许静默，真实error优先、user_start清标记，补直接事件断言；错误+技能19/19、两端types通过。编辑失败图报错滚出屏，移到编辑区保存按钮旁并补具体错误文本/拍摄断言。新390标题/正文左右边界已正常。
9. 最后owner **t_mvdiidlehty8g2** 的新build/任务UI/技能UI（新增正常等待无错误断言）/真实错误UI **4/4 PASS**（33.7/33.3/22.5/25.9秒）。主会话核汇总`evidence/beta32-validation/beta32-final-result9.txt`及最新任务草稿/技能desktop与390/额度desktop与390/任务详情390：报错与草稿同屏、技能正常等待无误报、错误详情与长文正常换行。真链6请求，quota无重试，临时rate/timeout首错公开停止已有backoff后idle。无本次e2e/launch-memory残留；无相关变化的Fast/static/boundaries不重复。

测试全部Node24.19.0；setup在config导入前隔离、内存credentials、临时HOME/TMP/DATA/WORKSPACE与Mock/loopback，不查真实账号额度、生产DB/Chrome profile、不动9225/小微/Laya。只读review sa_mvdh6z7tiyrxee无P0/P1，发现窄无start空结果遗漏后主会话已补且加公开事件直接测试；未按建议改成“有正文反而丢弃”。

## 发布前尚需

最终结果和stable桌面/390/错误图已主核，源码/日志和截图分开提交；正式main干净时pull再ff，原子push新tag，既有草稿→五平台→Mac/Windows安装启动→publish门禁已通过，Latest/13资产/六别名签名文本及Linuxchecksum已核。发布结果集中在[最终收口](beta32-release-final.md#发布状态)。保留失败记录、未验及其他worktrees/WIP/stash，不自动安装，不重复已完成的验收/打包。

## 仍未验

真实模型对自然语言授权/自主规划/产物质量、真实Fast加速费用、安装版WebKit/Safari/物理手机/跨平台完整任务、共享资源锁、background/subagent完整长期责任关联、供应商连接超时根因。不得把唤醒/执行结束/测试exit0当业务完成，不恢复已撤Laya实验或加新按钮把产品责任转给用户。
