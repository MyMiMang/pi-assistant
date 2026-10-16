import { CHAT_SETTINGS_KEY, SEND_SHORTCUT_OPTIONS, setSendShortcut, useSendShortcut } from "../composer";
import { Button, Help } from "./ui";

/**
 * 设置 › 聊天与输入（导航 key = composer.ts 的 CHAT_SETTINGS_KEY = "chat"，深链 `?settings=chat`）。
 * 现在只有「发送快捷键」一项：偏好按设备保存在 localStorage，单聊 / 群聊 / 子代理共用同一份，
 * 刷新后保持，不影响同一服务上的其他设备。发送快捷键的语义与输入法防误发见 docs/design/chat-send-shortcut.md。
 *
 * 接入由主整合 owner 在 Settings.tsx 做（避免两个 owner 同时改导航，本树不动 Settings.tsx）：
 *   导航：["chat", "聊天与输入", MessagesSquare]（放「偏好与系统」组）
 *   内容：{settings === "chat" && <ChatSettings />}
 */
export function ChatSettings() {
	const shortcut = useSendShortcut();
	return (
		<div className="space-y-5" data-testid="chat-settings" data-settings-key={CHAT_SETTINGS_KEY}>
			<section>
				<div className="mb-3 flex min-w-0 items-center gap-1.5 font-semibold">
					<span>发送快捷键</span>
					<Help>输入法选字（中文 / 日文）时的回车不会把消息发出去。这条偏好只保存在这台设备上。</Help>
				</div>
				<div role="radiogroup" aria-label="发送快捷键" className="flex flex-wrap gap-2" data-testid="send-shortcut">
					{SEND_SHORTCUT_OPTIONS.map((o) => (
						<Button key={o.value} role="radio" aria-checked={shortcut === o.value} variant={shortcut === o.value ? "primary" : "outline"} onClick={() => setSendShortcut(o.value)} data-testid={`send-shortcut-${o.value}`}>
							{o.label}
						</Button>
					))}
				</div>
				<p className="mt-2 text-xs text-mut2">单聊、群聊和子代理都用这个；发送按钮的提示会跟着变。</p>
			</section>
		</div>
	);
}
