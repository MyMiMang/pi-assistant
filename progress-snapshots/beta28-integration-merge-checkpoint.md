# beta.28 候选整合：合并检查点（15 分钟）

时间：2026-10-17（Asia/Shanghai）。worktree `release-candidate-validation`（本任务独占）。

## 起点与前置
- 起点候选 HEAD `6d6c1ee`（= 已公开 tag `v0.1.0-beta.27`，2026-10-16T12:48:14Z 公开 Latest，Actions `38901767310` 成功）。tag **未移动**。
- 起点工作区有 3 处 WIP（上一轮 `git commit` 超时未完成）：`docs/HANDOFF.md`、`docs/ROADMAP.md`、`docs/release-notes/v0.1.0-beta.27.md`，内容就是「beta.27 已公开核验状态」。已先精确 review 并提交保留：`9c09804 文档：记录 beta.27 已公开核验状态（HANDOFF/ROADMAP/发布说明）`。未 reset / 未 stash，无丢失。

## 六组分支合入（`--no-ff`，按序）
| 顺序 | 分支 | 分支 HEAD | 合并提交 | 冲突 |
|---|---|---|---|---|
| 1 | `laya-benchmark-selection-fix` | `9eb23c2` | `9003055` | 仅 `docs/HANDOFF.md`（保留双方段落） |
| 2 | `voice-incremental-input` | `9f61f1f` | `631456b` | 无 |
| 3 | `mobile-chat-history-performance` | `1f6f4b5` | `f3e8f3c` | `docs/HANDOFF.md`、`docs/ROADMAP.md`（保留双方段落） |
| 4 | `chat-content-overflow-fix` | `d4c5899` | `dad9600` | 无 |
| 5 | `subagent-composer-navigation` | `17f0652` | `f456c58` | `docs/HANDOFF.md`（保留双方段落） |
| 6 | `ui-consistency-motion` | `e47bac8` | `0ccadf4` | `docs/HANDOFF.md`、`docs/ROADMAP.md`（保留双方段落） |

- 六组分支 HEAD 与任务给出的预期**逐一核对一致**；`git rev-list --count HEAD..<branch>` 全部为 **0**（无漏合并）。
- doc 冲突一律**逐段保留**（现公开状态段 + 各候选事项段都留），未用 `-X ours/theirs` 覆盖整篇。
- 代码文件自动合并结果抽查：
  - `apps/web/src/themes/base.css`：`--pa-dur-*` 动效 token（ui-consistency）、`.pa-history-window`（mobile）、`.pa-voice-level`（voice）、`.pa-steps-list{display:grid}` 完整展开（ui-consistency）、`.pa-scroll-x/.pa-pre-x` 表格横向滚动（overflow）**同时在位**。
  - `packages/server/src/http.ts`：`settings.changed` 广播（laya）与 JSON gzip `compress`（mobile）**同时在位**。
  - `apps/web/src/components/ChatMessages.tsx`：`Steps` 结构 `pa-steps-list > ol` 与新 CSS 的 `0fr↔1fr` 折叠契约一致（仅 ui-consistency 改过该文件，mobile 的滚动联动在 `Chat.tsx`，无冲突）。
- 全仓无遗留冲突标记（`git grep '<<<<<<<'` 仅命中一张二进制 png 误报）。

## 合并后候选 HEAD
`0ccadf4`（合并检查点）。后续验收结论见 `progress-snapshots/beta28-final-validation.md`。

## 环境
- Node `v24.20.0`（`/opt/homebrew/opt/node@24`；系统默认 PATH 无 node，node@25 因缺 `simdjson` dylib 不可用）。
- `node_modules` 为**实体目录**（非共享 symlink），`@earendil-works/pi-coding-agent` = `1.3.0`，与 lock 一致。未改 Pi SDK / node_modules / 私有接口。
