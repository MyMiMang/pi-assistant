/**
 * 叠加层（弹层 / 紧贴按钮的悬停说明气泡）的 Esc 关闭顺序。
 *
 * 为什么需要它：菜单和气泡都监听 `document` 的捕获阶段 keydown。同一节点上的多个监听器按注册顺序执行，
 * `stopPropagation()` 挡不住同一节点上的其它监听器 —— 结果是「先注册的菜单」先把菜单关了，气泡随后也关，
 * 与设计相反（设计是 Esc 先关最上层的气泡，不误关菜单）。所以这里按**打开顺序**维护一个栈：
 * 只有栈顶那一层处理这一下 Esc，它关掉后这一下不再往下传；再按一次才轮到下面的层。
 *
 * 纯逻辑，便于单测（不依赖 DOM）；真正的 keydown 接线在 `ui.tsx` 的 `useEscLayer`。
 * 注意：这里只保证「谁有权处理」，真实浏览器里的捕获顺序 / 焦点行为仍需测试槽用 Chrome 复核。
 */
export interface EscLayer {
	consume: () => void;
}

export function createEscLayers() {
	const stack: EscLayer[] = [];
	return {
		/** 压入一层（打开时），返回注销函数（关闭 / 卸载时） */
		push(layer: EscLayer) {
			stack.push(layer);
			return () => {
				const i = stack.lastIndexOf(layer);
				if (i >= 0) stack.splice(i, 1);
			};
		},
		/** 这一层是不是最上层：不是就交回去，不在这一下里抢先关闭自己 */
		isTop(layer: EscLayer) {
			return stack[stack.length - 1] === layer;
		},
		/** 当前打开的层数（测试 / 诊断用） */
		size() {
			return stack.length;
		},
	};
}

/** 全局一份：菜单、气泡、设置弹窗里的帮助气泡共用同一套顺序。 */
export const escLayers = createEscLayers();
