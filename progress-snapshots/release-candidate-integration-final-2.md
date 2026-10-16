# Pi 1.3 候选整合收口（beta.25 候选，未发布）

- 日期：2026-10-16
- 候选树：`release-candidate-validation`
- HEAD：`1ebcea7`（在 `4649d32` Jev 合并之上；本轮全部提交见下）
- 状态：**未 push / 未 tag / 未打包**；beta.24 仍是公开 Latest，tag `747c744` 未移动。
- 环境：Node 24.19.0（`/Users/dengdeng/.local/node-v24.19.0/bin`），独立 worktree 自身 `node_modules`；不合并 `node_modules`、不改 Pi SDK。

## 本轮提交（都可回滚）

| commit | 内容 |
|---|---|
| `086b375` | 合并 `model-picker-favorites-fix`（d5f4f51/ad42540）：常用只做顶部快捷入口，不从原渠道搬条目；去重限同分组 |
| `2552cbe` | 合并 `composer-send-shortcut`（b238bdb..d42f615）：Enter 发送 / Shift+Enter 换行 + 输入法防误发；ChatSettings 组件随并 |
| `d9d8984` | 主整合：`ChatSettings` 挂进 `Settings.tsx`（导航第 17 项 `chat`「聊天与输入」，偏好与系统组） |
| `fff9869` | 主整合：Laya 主卡精简（单状态 + 详情折叠）+ 快速操作模型叫法统一 + 技术说明进 Help + 一句话空态 |
| `b98421e` | 测试：Laya 断言改按新单一状态 |
| `0587ad0` | 测试：send-shortcut-ui 补「聊天与输入」页用例 |
| `61abec6` | 测试：settings-functional-ui 导航断言 16→17 |
| `4649d32` | 合并 `fast-model-auto-discovery`（9dca49c..3322db7）+ 修保存自定义服务偶发 `Unknown provider` |
| `88f40cc` | 测试：常用截图前把原渠道行滚入视口（纯证据） |
| `b6bf995` | 测试：fast-computer-ui 补证据截图 |
| `1ebcea7` | 合并 `settings-usability-polish`（5901f57..ef863b7） |

## 关键修法：保存自定义服务偶发 `Unknown provider`

- 文件 / 方法：`packages/server/src/pi-adapter/custom-providers.ts` · `CustomProviders.save()` · 第 359 行。
- 改动：`await this.models.reloadConfig()` 之后，若 `this.models.listProviders()` 里还没有该 `pid`，再 `await this.models.reloadConfig()` 一次。
- 原因：上一次注册（classifier 扩展层 / provider 变更）触发的 Pi 后台 `refresh` 与本次 `reloadConfig` 竞态，刚写入 `models.json` 的 provider 偶尔还没进目录，`login` 就报 `Unknown provider`。
- 边界：**有界单次**，不掩盖其它 `login` 身份 / 凭据错误，不做重复付费探测。
- 证据：`test/fast-model-auto-discovery.test.ts` 修前 10 次跑 2 次失败（`custom-unknown` 未进 provider 目录），修后 6/6 稳过。

## 实跑 counts（本轮已跑，不再全量重跑）

| 用例 | 结果 |
|---|---|
| web `tsc --noEmit` / `vite build` | exit 0 / 通过 |
| server `tsc --noEmit` | exit 0 |
| `fast-model-auto-discovery` | 9/9 |
| `fast-model-discovery-http` + `model-registry` + `fast-computer-tool` + `fast-computer` + `classifier`（合跑） | 67/67 |
| `model-menu-grouping` | 7/7 |
| `e2e/send-shortcut-frontend.test.mjs` | 21/21 |
| `e2e/send-shortcut-ui.mjs` | 全过（含新增设置页 390） |
| `e2e/model-picker-favorites-ui.mjs` | 7 组全过 |
| `e2e/model-ui.mjs` | 全过 |
| `e2e/model-services-ui.mjs` | 全过（含 Laya 新状态断言） |
| `e2e/settings-functional-ui.mjs` | 52/52 |
| `e2e/settings-usability-ui.mjs` | 33/33 |
| `e2e/settings-desktop-resources.mjs` | 40/40 |
| `e2e/fast-computer-ui.mjs` | 全过 |
| `e2e/channel-delete.mjs` | 全过 |
| `e2e/memory-provider-select.mjs` | 全过 |
| `e2e/subagent-thinking-levels.mjs` | 24/24 |
| `e2e/skill-pick-ui.mjs` | 23/23 |
| `e2e/voice-input-ui.mjs` | 全过（42 行） |
| `e2e/message-replies-ui.mjs` | 37/37 |
| `e2e/session-fork-ui.mjs` | **6/6**（安全入口修复后；见下节） |

## 证据截图

- Laya 主卡（单状态）：`evidence/settings-functional-ui/03b-host-laya.png`
- 聊天与输入页：`evidence/send-shortcut/07-chat-settings.png`、`evidence/send-shortcut/06-chat-settings-390.png`
- 模型菜单「常用 + 原渠道」同屏：`evidence/model-picker-favorites/02-single-provider-group-kept.png`、`03-multi-provider-kept.png`
- 快速操作模型选已配 Jev：`evidence/fast-computer/fast-computer-jev-selected.png`

## 未验 / 边界（不声称已验）

- 真机 App / 真麦克风 / 真实云 ASR 与云模型计费；真实 IME 与真 Safari（只有事件序列 + CDP 合成组合）。
- 全量 `e2e/run.mjs`（第 1 步首次运行向导为既有基线失败）。
- `e2e/session-fork-ui.mjs` 此前记成「候选树与合入前 `composer-send-shortcut` 树都只 3/5，非本轮引入、未定位」——**该结论已作废**。已确认的原因是测试隔离问题（确认测试隔离风险，修正后稳定，未在旧不安全环境重现验证唯一因果）：旧 e2e 直接 `spawn packages/server/src/main.ts`，只设 `PIA_DATA_DIR` 却**继承真实 `PIA_WORKSPACE`**、未注入内存凭据后端；第 2 条消息发送时服务端仍会走安全凭据后端（可能触钥匙串 / 真实工作区），Mock 回复与 settle 被拖住，等输入框清空超时。改用测试入口 `test/launch-memory.ts`（内存 `CredentialStore`）+ `PIA_WORKSPACE=<临时 DATA>/workspace` 后稳定 **6/6**（连跑 3 次），并直接断言服务端收到两条 user 消息、Mock 两条 `done`、`POST /messages` ≥ 2（不再按 UI 计数猜抖动）。真实原因、修法与 0 钥匙串证据见 [release-candidate-security-fork-closeout.md](release-candidate-security-fork-closeout.md)。
- 真实云 Jev 分类请求 / 真实官方目录登录后的自动识别链路（本轮为环回假 relay + 临时数据）。
