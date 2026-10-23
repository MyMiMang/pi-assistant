/**
 * 复制文字 / 读选区的唯一入口。
 * - copyText：优先 Clipboard API；手机经局域网 http 打开时没有这个 API（非安全上下文），退回 execCommand。
 * - selectionBeforeRightClick：右键那一刻之前的选区。macOS 右键会先自动选中光标下的一个词，
 *   所以不能用右键之后的选区判断「用户选了什么」（rememberSelection 要在 mousedown 捕获阶段调用）。
 */

/** 复制成功返回 true。 */
export async function copyText(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard && window.isSecureContext) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// 权限被拒等：走下面的兜底
	}
	const ta = document.createElement("textarea");
	ta.value = text;
	ta.setAttribute("readonly", "");
	ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
	document.body.appendChild(ta);
	ta.select();
	let ok = false;
	try {
		ok = document.execCommand("copy");
	} catch {
		ok = false;
	}
	ta.remove();
	return ok;
}

let pressed: { text: string; node: Node | null } = { text: "", node: null };

/** mousedown（捕获阶段）调用：右键按下时记下当时的选区。 */
export function rememberSelection(e: MouseEvent) {
	if (e.button !== 2) return;
	const sel = window.getSelection();
	pressed = sel && !sel.isCollapsed && sel.rangeCount ? { text: sel.toString(), node: sel.getRangeAt(0).commonAncestorContainer } : { text: "", node: null };
}

/** 右键前选中的文字；给了 within 就只认整段落在它里面的选区。 */
export function selectionBeforeRightClick(within?: Element | null): string {
	if (!pressed.text.trim()) return "";
	if (within && !(pressed.node && within.contains(pressed.node))) return "";
	return pressed.text;
}
