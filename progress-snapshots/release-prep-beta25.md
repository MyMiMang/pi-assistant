# beta.25 发布准备（release-candidate-validation，本轮）

> 目标：把 beta.25 候选做成可发布状态——写用户可读发布说明、跑发布前静态核查、普通 ff 推 main + 新建 tag 触发 CI。
> 树：`release-candidate-validation`（基线 `origin/main` = `decb8eb`，即 beta.24 已公开后的文档提交；候选 `8b1aedd` 之上 64 个提交 / 83 个改动文件）。发布范围 `.github/release-scope.json` = `mac-arm64`。
> 状态：**v0.1.0-beta.25 已公开为 Latest**。tag `8afc3aa5d4383e37e14050617b6e1ede67b8f8c9`；[release run 38857423620](https://github.com/MyMiMang/pi-assistant/actions/runs/38857423620) 的 prepare / arm64 build / 内置服务冒烟 / mac-smoke / publish 均成功，2026-10-16 05:57:00 UTC 公开。主会话独立核验 Release 非草稿、非 prerelease，四项资产已上传；Latest 下载的 `latest.json` 为 `0.1.0-beta.25`，仅 `darwin-aarch64` / `darwin-aarch64-app` 且更新签名非空。只构建 arm64，未移动 beta.24 或任何旧 tag。未在用户电脑安装 / 替换 App。以下为发布前实施记录，未验边界保持不变。

## 0. 版本与边界

- 上一公开版 **v0.1.0-beta.24**（tag `747c744`，Latest，仅 arm64），本轮发布 **v0.1.0-beta.25**，**只构建 Apple 芯片 macOS（mac-arm64），跳过 Intel / Windows / Linux**。
- 不修改已发布 tag；`v0.1.0-beta.25` **只新建一次**，指向本轮已验 HEAD。
- 不改 Pi 本体 / 不 fork / 不改 `node_modules` 源码；Pi 精确 pin `1.3.0`（`compat.json` `testedWith` = 1.3.0，`check:pi` 一致）。

## 1. 发布说明（新增）

`docs/release-notes/v0.1.0-beta.25.md`（中文、面向用户、精简）。要点：**Enter 默认发送醒目说明 + 设置 › 聊天与输入可改 + 「IME 防误发是事件序列自动测试、不是全真 OS 保证」**；设置按功能重排（5 组 17 项）；语音来源必须显式选择（不默认云端、不静默计费）；**本地 Laya 是快速操作分类模型、不是语音**（不写进语音）；Jev 自动识别只按可靠 metadata、不靠名字猜；模型「常用」不搬原渠道；Pi 1.3.0 收益（resume 恢复工具语义，不裁 1.3 特性，不改 SDK）；状态错误 / 权限归位 / Help 精简 / 测试隔离加固；已知未验（真 ASR / 真 Jev / 本地权重安装 / 真 iOS / 真 Safari）与 SenseVoice 许可 unresolved（默认不下载、仅合法权重导入）、**钥匙串根因仍未确、不承诺修好**。

## 2. 文档措辞修正（不删证据）

`progress-snapshots/release-candidate-security-fork-closeout.md`、`release-candidate-integration-final-2.md`、`docs/HANDOFF.md`：把 session-fork「3/5」的表述从「**真正原因**」改为「**确认测试隔离风险，修正后稳定，未在旧不安全环境重现验证唯一因果**」。保留全部实际证据（服务端收到两条 user 消息、两条 Mock `done`、`POST /messages ≥ 2`、`security` 探针计数 0、`storeCalls>0`）。

## 3. 状态标注（candidate）

`docs/HANDOFF.md` / `docs/ROADMAP.md` / `docs/DESIGN.md` 页首：当前公开版本仍写 **v0.1.0-beta.24**；新增一行 **v0.1.0-beta.25 候选（已发布准备、未公开）**，指向本快照与发布说明，并注明**只有 release workflow 全部成功后才改成公开**。

## 4. 发布前核查（本次实跑）

| 检查 | 结果 |
|---|---|
| `git diff --check origin/main...HEAD` | 通过（无空白 / 冲突标记） |
| 改动文件数 / 是否含 `node_modules` | 83 个文件；**0 个** `node_modules` 路径；候选自有 `node_modules` 为官方 1.3.0 |
| 敏感路径扫描（只看路径元数据，不读 deny 文件内容） | 无 `secrets` / `.env` / `*.key` / `*.pem` / `*.db` / `hosts.yml` / token 类路径 |
| `node scripts/release-scope.mjs` | `scope=mac-arm64`，仅 1 个 arm64 构建项（无 Windows / Linux / Intel） |
| `node --test scripts/release-scope.test.mjs` | **3/3** |
| `npm run check:pi` | `Pi 已安装 1.3.0 · 兼容基线 1.3.0 · npm 最新 1.3.0` |
| `npm run typecheck`（server + apps/web） | exit 0 |

**未重复全量测试**（按约定：8b 候选已跑过的受影响项 / 专项 / 安全 launcher 4 用例不复跑；不跑 23 个仍直接 spawn 生产 `main.ts` 的旧 e2e，也不跑约 25 分钟的全量 `e2e/run.mjs` / 全量 `npm test`）。已记录的候选 counts 与未验边界见 `release-candidate-integration-final-2.md`、`release-candidate-security-fork-closeout.md`、`pi-1.3-integration.md`。

## 5. 既有基线 / 未验（不声称全绿）

- `e2e/run.mjs` 第 1 步「首次运行向导」等旧「设为默认模型」按钮，`main` 上同样失败（既有基线，非本轮引入）；全量 `npm test` 亦有既有基线失败（如 `shared-computer` 的 macOS `bsdtar --skip-old-files`）。**不把存在基线 failure 说成「全部绿」**。
- 真实云模型 / 真实云 ASR / 真麦克风 / 本地 SenseVoice 真实安装转写 / 真实 Jev / 真机安装包与真机更新 / 真 iOS / 真 Safari 与真实系统输入法 / 真实 MCP 与电脑操控基准，均**未验**。
- 系统钥匙串弹窗根因仍未查明，不承诺修好；未重置钥匙串、未清空用户数据。
- SenseVoice 许可 `unresolved`：默认下载关闭，仅合法权重导入。

## 6. 发布动作

1. 提交本轮发布准备（发布说明 + 措辞修正 + 状态标注 + 本快照）。
2. `git fetch origin main` 重新确认 `origin/main` 未前进 → `git push origin HEAD:main`（**普通 ff，不 force**）；若 main 已有他人提交则整合后再推，不 force / 不 reset。
3. 同一已验 HEAD 打 **轻量 tag `v0.1.0-beta.25`**（只新建一次，不动 beta.24 或既有 tag）并推送 → 触发 release workflow。
4. 记录 run ID / URL / 阶段；**run 未结束不写「已发布」**。infra 失败可原 run rerun；源码原因需新提交 + 下一个未占用 tag（由主决定，不移动本 tag）。
