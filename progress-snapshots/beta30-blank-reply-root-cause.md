# beta.30「助手回复正文空白」根因与修复（2026-10-18）

> 状态：已修复为空的 error/interrupted 消息不显示错误的确定缺陷；主会话已构建并在Chromium的noir/pixel明暗四组合中验证正常正文、两个空错误与中断提示可见。仍未安装候选App或证明网络超时根治。

## 现象
用户在 beta.30 上看到多段助手回复「只剩思考 › / 引用 / Fast 行，没有正文」，跨 noir / pixel 两个主题一样；用户消息、工具步骤、思考折叠条、Fast 回显都正常；同一 App 里换到「全能培训师」助理后正文正常（同模型 gpt-6.1-sol）。

## 根因（两件事，别混）
1. **显示层真 bug：失败的那一轮什么都不显示。**
   - 服务端对失败轮落库的是 `content: ""` + `status: "error"`（`runtime.ts` 的 `assistant_end` 分支；只有「无正文且无思考」且**非** error 时才删消息）。
   - `ChatMessages.tsx` 旧的气泡渲染条件是 `body || (status === "streaming" && !thinking)`，而 `meta.error` 的文案**只写在气泡内部** → 失败轮整个气泡不渲染，界面上只剩 `MessageActions`（引用），看起来就是「回复了但正文空白」。
   - 这解释了全部矛盾：跨主题一样（不是主题动画）、Markdown 29→30 无 diff、服务端 content 有值（最新几条本来就是成功的）。
2. **对应时段存在请求超时；网络具体原因尚未证实。**
   - 只读 Pi 会话日志（结构/长度，无正文）：02:16–02:25（CST）连续 **24 轮** `stopReason: "error"`、`errorMessage: "Request timed out."`（最后一次 `Connection error.`）、`durationMs ≈ 10.2–10.4 s`、`content` 长度 0；02:25:46 之后恢复，成功轮 8.5–13.7 s。
   - 用户三张截图的时刻（02:19 / 02:22 / 02:26）正落在超时窗口里 → 那些空白行就是失败轮。
   - 主会话限定只读本agent最近200消息的HTTP统计：15条done有正文、12条done无正文、25条error无正文，其中23条错误含超时。该证据确认空error路径与用户时段一致，最新几条成功消息有正文不能代表历史空白行。
   - 独立SDK源码审计：Pi SDK请求deadline默认300s，undici connect默认10s、OpenAI多种超时会归一为`Request timed out.`。目前未取得每次失败的底层cause，不能单靠约10s断言TCP/代理/网关故障，也不能断言模型慢。不改超时值、不新增重复重试、不自动切模型。
   - Pi自动重试开始/结束尚未映射为App专门的重试进度，这属后续体验缺口，未在本次冒充已修；失败气泡必须先清楚显示。

## 改动（小、只碰消息层）
- 新增 `apps/web/src/message-body.ts`（纯函数）：`botBodyView({body, thinking, status, error})` + `assistantErrorText(error)`。
  - error / interrupted **一律** `showBubble = true`；
  - 错误翻成人话（超时 / 连不上 / 鉴权 / 限流 / 上下文 / 5xx），未匹配的保留原文（截断 120 字），原文同时放 `title`；
  - 对象型 / 空错误给通用一句，**绝不**露出 `[object Object]` / `undefined`。
- `apps/web/src/components/ChatMessages.tsx`：`BotPart` 用 `botBodyView` 决定是否渲染气泡；错误行/中断行加 `data-testid="msg-error"` / `msg-interrupted`，无正文时不再带 `mt-1`。
- 没动共享 CSS、没动 `@layer base` / `button{white-space:nowrap}`、没动 Markdown、没动服务端、没动 Pi SDK / node_modules。

## 实跑
- `node --import tsx --test e2e/message-body.test.mjs` → **9/9 通过**（Node v22.23.3，App 自带；含"失败且无正文必须显示气泡"、"未知错误保留原文"、"超长截断"、"不露 [object Object]"）。
- `tsc --noEmit -p apps/web` → exit 0。
- 主会话补充：web build与四组合真实DOM通过，正常正文/无正文超时/连接错误/中断都可见。首次fixture缺host-control结构导致pageerror，补齐假API后通过；非产品行为迁就。真机候选/全量测试未跑。

## 残余风险 / 待确认
- 空error行前提已由主会话HTTP聚合确认（见上）；只统计，不输出聊天正文/凭据。
- 若修复后用户仍看到"有内容但不可见"，那才是第二类问题（正文不可见），需要同 bundle 本地复现 + computed style，别再用猜测。
- 超时那条会让"失败轮"持续产生；不修超时，用户会反复看到（修复后至少能看见一句人话原因）。
