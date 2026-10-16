# 检查点：「操作这台电脑」底部操作条去 sticky 浮层（beta.27 候选，未发布）

- 时间：2026-10-16
- worktree：`beta26-settings-feedback-fix`（`git worktree`，同树 HEAD 起点 `476e73a`，clean）
- 状态：**未 push / 未 tag / 未打包 / 未安装 App**；beta.27 候选

## 用户原需求
用户 beta.26 反馈：设置 › 操作这台电脑 页底部操作条（「查看权限清单…」「保存更改并重新确认…」「已保存草稿（未开启）」）是浮层，滚动时压在正文与提示上，挡住下方内容。

## 改动（1 处生产代码）
`apps/web/src/components/HostControl.tsx` 第 363 行：
- `sticky bottom-0 z-10 flex … bg-card/95 backdrop-blur` → `flex … bg-card`
- 操作条回到普通文档流；权限审阅（review）/ 未保存提示（dirty）/ 保存 / 关闭态自动保存（autosave）/ ack + 确认开启（host-enable）/ 系统权限引导等原有流程与档位语义不变。
- **不改产品权限档位、不动后端**；未改本地模型列表 / 许可 / ASR gate（此前过滤需求已撤销，未写过 filter）。

## 验证（全进程外隔离，未碰用户真实数据）
环境：Node v24.20.0；`mkdtemp` 临时 `HOME` / `PIA_DATA_DIR` / `PIA_WORKSPACE` + `npm_config_offline=true`；只读复用 `release-candidate-validation` 的 `node_modules`（软链，未改依赖 / 未改 node_modules / 无 SDK patch）；静态 `apps/web/dist` + `page.route` 夹具；未碰真实 App / 桌面 / 配置 DB / 密钥 / `secrets.ts`。

- `e2e/settings-usability-ui.mjs` **全部通过**（A–F）。新增 F 段：
  - 桌面 1440×900 与 390×844 **真实 DOM 滚动**：操作条位移≈滚动量（非 sticky 固定）；
  - 把「macOS 权限」提示滚到底，操作条不与其重叠；
  - 保留 review → ack → 确认开启流程，开启后绿色提示不被操作条遮挡；
  - 全流程无原生弹窗；390 不横向溢出。
- **负向对照**：把该行临时改回 sticky 重跑，F 段「随内容滚动」「不覆盖下方提示」如实失败（位移=0.0、与提示重叠），证明断言非空转（非仅 class 断言）。
- `apps/web` + `packages/server` `tsc --noEmit` exit 0；web `vite build` 通过。

## 截图（已识图核对）
`evidence/beta26-hostcontrol-flow/F-host-action-desktop.png`、`evidence/beta26-hostcontrol-flow/F-host-action-390.png`：按钮在内容流中，绿色「已开启」提示完整可见，无浮层遮挡。

## 提交（本地，中文小提交）
- `49a2066` 修复：操作这台电脑底部操作条去掉 sticky 浮层，回普通文档流不再遮挡下方内容
- `c80d926` 测试：操作这台电脑底部操作条真实 DOM 滚动回归（桌面/390，含负向对照）
- `363cb46` 文档：记录操作这台电脑底部操作条去浮层（beta.27 候选未发布）

## 未验
真机 App、全量 `npm test`、全量 `e2e/run.mjs`。
