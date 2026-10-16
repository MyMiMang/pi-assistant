# 发送快捷键 + 输入法防误发（chat-send-shortcut）

需求（2026-10-16，用户原话大意）：「现 Shift+Enter 发送，因为此前中文 IME 回车确认候选会误发送；能修的话改回 Enter 发送，并设置可选 Enter 发送 / Shift+Enter 发送」。
历史：beta.19 起为了绕开中文输入法回车确认误发，把发送键改成了 Shift+Enter（见 [ROADMAP](../ROADMAP.md) 对应行，**默认值已被本条覆盖**，IME 防误发要求继续有效）。

## 1. 偏好（`apps/web/src/composer.ts`）

- 取值：`"enter"` = Enter 发送 / Shift+Enter 换行（**默认**）；`"shift-enter"` = Shift+Enter 发送 / Enter 换行。
- 存储：`localStorage["pia.chat.sendShortcut"]`，和主题 / 语言 / 布局一样**按设备**保存，不进服务端 `settings`（同一台服务上的其他设备 / 手机不受影响）。
- 缺省（含旧版本没有这个设置）→ `"enter"`；**读到 `"shift-enter"` 一律保留**，不覆盖用户的显式选择。
- 单聊 / 群聊 / 子代理共用同一份：模块内一份状态 + `useSyncExternalStore`（`useSendShortcut()`），另外监听 `storage` 事件跟随其他标签页，不用各自维护半套状态。
- 文案一处定义：`sendHint(shortcut)` / `sendKeyshortcuts(shortcut)`，三个输入栏的按钮 `title` / `aria-keyshortcuts` / 输入栏提示都读它。

## 2. 按键判定（单点）

`decideComposerKey(e, shortcut, guard)` → `"send" | "block" | "native"`，三条输入栏都走 `useComposerKeys(onSend, ownKeyDown?, resetKey?)`，
页面自己的判断（Esc 取消引用、@ 候选上下键 / Enter、技能菜单）用 `ownKeyDown` 排在前面；`resetKey`（对话 / 群 / 子代理 id）变化时清掉组合状态。

判定顺序（前面的先赢）：

1. `guard.composing()` / `isComposing` / `keyCode === 229` → `native`（**绝不 preventDefault**，否则会打断选字）；**只有 `key === "Enter"` 才 ack**（见 §3）。
2. `Ctrl` / `Alt` / `Meta` 组合 → `native`（Mac 的 Cmd+… 不被抢）。
3. 已被 `preventDefault`（弹窗 / 菜单 / @ 候选已处理）→ `native`。
4. 非 Enter → `native`。
5. WebKit：`compositionend` 刚结束 → 这次回车是确认键，`native`（只吞一次）。
6. 偏好里不属于「发送」的那个组合 → `native`（换行交给浏览器原生）。
7. 按住不放的自动重复 → `block`（只 `preventDefault`，不连发、不留空行）。
8. 否则 → `send`（调用方 `preventDefault` 后发送；空草稿 / 忙时的判断仍在各页 `send()` 里，语义不变）。

## 3. 输入法（IME）防误发

只有布尔量不够：**WebKit（Safari / WKWebView）在回车确认候选时先发 `compositionend`，再派发那次回车的 `keydown`**，此时 `isComposing` 已经是 `false`。
`createCompositionGuard()` 的模型：

- `compositionStart()` 开始；组合中的 **Enter** keydown（Chrome / Firefox，通常还带 `keyCode 229`）记 ack —— 这次确认键已经在组合里见过了。
- `compositionEnd()`：若刚才有 Enter ack，**不粘**任何后续回车（Chrome / Firefox 次序：确认完马上再按一次回车就能发送）；否则记下「刚结束」，等 WebKit 那次确认回车。
- 下一次 Enter keydown 落在 `IME_CONFIRM_WINDOW_MS = 120ms` 内（含同刻 / 几毫秒倒挂）→ 当成确认键吞掉**一次**并立刻清状态；超出窗口直接清掉、正常发送。**不用长 timeout 把之后的回车都堵住**：确认完再按一次回车必须能发送；鼠标点候选（没有回车事件）的下一记回车也不会被长期吞。
- 时间比较只用同一时钟：两个事件都有 `timeStamp` 就用事件钟，否则两个都用 `performance.now()`，绝不跨 clock 相减。
- 方向键 / 退格这类组合中的按键**不** ack（它们不结束组合），否则 WebKit 的兜底会被误解除。

## 4. 设置页接入（留给主整合 owner）

- 组件 `apps/web/src/components/ChatSettings.tsx`（`export function ChatSettings`），导航 key 冻结为 `composer.ts` 的 `CHAT_SETTINGS_KEY = "chat"`（深链 `?settings=chat` 直接可用，`store.ts` 已按 URL 原值打开）。
- 在 `Settings.tsx` 里加：导航 `["chat", "聊天与输入", MessagesSquare]`（「偏好与系统」组）＋内容区 `{settings === "chat" && <ChatSettings />}`（主整合 owner 的候选 `b9e5d5a` 已定这个 key / 文案）。设置 IA 由另一位 owner 重排，本树不动 `Settings.tsx`，避免两个 owner 同时改导航。
- 页面只有一项「发送快捷键」（两个按钮二选一，`data-testid="send-shortcut"` / `send-shortcut-enter` / `send-shortcut-shift-enter`），IME 说明收在一句 `Help` 里，不常驻长解释、不放「去设置」链接。

## 5. 验收

- 纯逻辑 `e2e/send-shortcut-frontend.test.mjs` **21/21**（缺省 / 显式偏好、存储读写与异常、订阅、①组合中 ②229 ③WebKit 次序 + 只吞一次 ③c Chrome 次序 ③d 方向键不 ack ④鼠标选字 ⑤两种偏好 ⑥repeat ⑦reset ⑧已处理）。
- 真实 UI `e2e/send-shortcut-ui.mjs` **38/38**（默认 Enter；切偏好 + 刷新保持 + 另一台设备仍是默认；合成 composition 的 Chrome / WebKit 两种次序、229、repeat、`preventDefault`；CDP 真组合中不发 + 组合结束后 Enter 一定发；群聊 @ 候选只选人；子代理输入栏同偏好；引用 + Enter 发送；390 不被挤）。
- 回归（脚本里「Shift+Enter 发送」改成新默认的 Enter）：`composer-compact` 45/45、`skill-pick-ui` 23/23、`message-replies-ui` 37/37、`voice-input-ui` 38/38；web `tsc --noEmit` + `vite build`。

**未验（如实）**：真机 / 真输入法（iPhone Safari、macOS Safari 真候选框）只有事件序列级证明；Chrome 侧是 CDP 合成组合，真机确认回车是否还会带一个 `\n`（合成组合会带，真 IME 通常不带）未验证——若真机出现，可在「判定为确认键」时 `preventDefault`（候选已提交，不影响选字），但本轮按「组合中交浏览器原生处理」不这么做。移动软键盘 Enter 不做特殊分支：浏览器把它报成组合/`isComposing` 就按输入法处理，否则按当前偏好（与桌面同一策略），未在真 iPhone 上验证。
