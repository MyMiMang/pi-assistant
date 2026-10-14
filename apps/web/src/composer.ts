import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/** 输入框快捷键提示（发送按钮 title / 输入区提示共用）。 */
export const SEND_HINT = "Shift+Enter 发送，Enter 换行";

/**
 * 输入栏按钮里的文字标签：聊天区窄时只留图标，文字信息改由按钮的 title / aria-label 提供。
 * 判断依据是**容器宽度**而不是视口宽度 —— 三个输入栏的 .pa-composer 上都加了 @container，
 * 所以大屏被左右两栏挤压时同样会 compact；max-sm 只在没有容器祖先时兜底。
 */
export const COMPOSER_LABEL = "max-sm:hidden @max-[660px]:hidden";

/**
 * 键盘上是否按下了「发送」：Shift+Enter 发送，单独的 Enter 换行。
 * 组合输入（中文/日文选字）期间不触发：isComposing 之外，Safari 在
 * compositionend 后不再置位，只留一个 keyCode 229，这里一并挡掉。
 */
export function isSendKey(e: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
	if (e.key !== "Enter" || !e.shiftKey) return false;
	return !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229;
}
