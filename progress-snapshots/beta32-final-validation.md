# beta.32 群成员配置与技能提议收口

2026-10-18 · 工作树 `beta30-followup-integration` · 起点 `885ed08`。用户明确授权「弄完就提交打包」。当前为候选，公开版仍 beta.31；未自动安装或重启用户 App。

## 最终行为

- 建群/加成员/助理设置共用 `DraftModelSettings` 与自有分组模型选择、思考滑块，使用实际目录和默认元数据。保留中文服务名、角色推荐/价格/排除理由；加载失败重试、未知默认不伪最低档、固定档不造七档。确认后服务端按最终实际模型 clamp，已有助理仅加入群、不改配置。
- 点击成员的概览即可 live 修改模型/思考，显示立即保存、后续请求生效与私聊共用范围，可恢复跟随。live 同助理串行写入，响应同步原始与有效字段，不覆盖 Fast；失败可见，不乐观改成假成功。设置保持显式保存草稿，失败保留重试，未编辑模型/强度不随资料保存重发。
- HTTP PATCH 先校验 thinking/Fast 再写模型/资料，非法组合不能先改库再400。
- 技能自动提议先由当前会话总结名称、做什么、使用时机与结果，宿主校验候选/归属/TTL/一次性/长度/非泛泛模板后才展示卡片。证据不足/泛泛/明显失败不提。用途总结产生正常模型用量，设置Help已说明。
- 技能用途卡等待与模型轮解耦，未回答助理空闲，用户同意后再查重/保存。停止/取消/重启作过期，保留拒绝/静音、查重、更新diff及原授权。详见[技能记录](skill-proposal-purpose.md)。
- [Rovai固定版本研究](../docs/research/rovai-ai-group-design-review.md)主抽核Task/投递校验、历史模型与能力界面、默认收件提示；仅参考设计，无代码复制/依赖。后续优先实际执行快照与投递/停止事实，未增任务看板或异构运行时。

## 实际验证

统一 Node `/Users/dengdeng/.local/node-v24.19.0/bin/node` v24.19.0。服务端setup在导入前强制临时DATA/WORKSPACE/OFFLINE，HTTP/UI用临时HOME/DATA/WORKSPACE/TMP、内存凭据和Pi Mock，渠道仅loopback；原生Chrome用browserEnv恢复OS环境。没有真实模型付费或生产数据库读取。

| 检查 | 实际结果 | 证据 |
|---|---|---|
| 两端 `npm run typecheck` | exit0 | `logs/beta32-typecheck.log` |
| web `npm run build -w @pi-assistant/web` | 通过，`index-DQQyhWub.js` / `index-Bgm5xKOF.css` | `logs/beta32-build-final.log` |
| rooms/proposal-member-thinking/proposal-models-http | 21/21，通过真实临时DB及loopback HTTP | `logs/room-member-server-final.log`；隔离启动helper调整后HTTP2项重跑 `logs/beta32-proposal-http-final.log` |
| skill-intel/skill-propose-ext/assignments/import/pi-events-union/fast-mode | 47/47 | `logs/beta32-server-final.log` |
| frontend Fast/model-menu/thinking-slider/release-scope | 58/58 | `logs/beta32-pure.log` |
| `room-member-model-settings-ui.mjs` | 七组完整流程全通过，含断WS的原始/有效字段、延迟写入+切成员、失败保留重试、资料保护、目录重试与固定档 | `logs/room-member-settings-ui-direct.log` |
| `skill-proposal-purpose-ui.mjs` | 真实Pi Mock全链、先用途再同意、未同意不创建、卡片等待助理空闲、同意后查重保存、无第二次新建确认 | `logs/skill-purpose-ui.log` |
| `fast-mode-ui.mjs` | 64/64 | `logs/beta32-fast-ui.log` |

服务端运行命令：在 `packages/server` 下 `node --import tsx --import ./test/setup.ts --test --test-concurrency=1 <上述文件>`；纯检查 `node --import tsx --test e2e/fast-mode-frontend.test.mjs e2e/model-menu-two-level.test.mjs e2e/thinking-slider-frontend.test.mjs scripts/release-scope.test.mjs`。UI均先web build，由主会话串行执行、finally关闭浏览器/独占服务并清本次临时目录。收尾新鲜进程检查未见本轮launch-memory/浏览器脚本或该前缀Chrome残留；未动生产进程。

截图目录 `evidence/room-member-model-settings/`、`evidence/beta32-skill-purpose/`、`evidence/beta32-fast/`。主会话实际打开群分组/390目录/390强度/保存错误四图、技能桌面/390两图；之前群设置/概览图另有查看，不将截图生成等同全部逐张视觉验收。群图01/05中文中转组当前折叠，源/API/UI断言另验证可展开选真实模型。

## 复核与夹具纠正

- 独立群复核发现字段合并遗漏/失败静默/默认不可恢复；已改并通过无WS及失败/跟随路径验证。
- 独立技能复核未发现新授权绕过，指出卡片工具阻塞执行；主会话改为出卡即返回、异步等回答，真Pi UI确认未回答状态为idle。确认候选工具归属/TTL/一次性/字段与迁移，重启/停止过期。
- UI扩展初跑有测试脚本变量 `relay` 未定义、错误testid `model-compact-model`/`model-fast`、设置藏在更多菜单、异步目录尚未加载时过早断言。逐一修正定位/等待，未削弱持久化和断WS断言；最终七组通过。最初reload回私聊由明确 `?room=id` 修正。纯检查首次漏 `--import tsx` 导致tsx未知扩展，正确命令58通过。HTTP测试改复用共享临时服务helper后补齐.mjs类型注释，最终两端类型通过。无gitleaks可执行或本树pre-push钩子，未声称跑过完整密钥扫描。

## 仍未验证与下一步

- 未跑全量npm test/e2e、Tauri WebKit/Safari、物理手机、Windows/Linux完整任务或新候选本机安装。发布CI安装启动冒烟另行核验。
- 模型真实服务、用途语义质量、Fast账号实际加速/费用未付费测试；失败词过滤有限，不能自动证明所有任务已做成。
- 请求超时根因依然未知；本轮未调超时/重试/思考/模型。系统TCC跨更新仍需稳定签名与实际升级验证。ASR完整麦克风/独立质量/跨平台任务另排。
- 优先序：已授权修复发布→实际请求失败原因/重试状态的可信诊断（沿用公开SDK、无付费盲试）→运行级模型/思考请求快照与投递/停止状态→再评估长期多人任务呈现。取消的Laya实验与产品选择器不恢复。

## 发布状态

待最终提交、新不可变 `v0.1.0-beta.32` tag 和 all-intel五平台构建/Mac+Windows安装启动/publish。beta.31 tag不动。公开后补写run id、源码SHA、资产与更新清单新鲜核验。
