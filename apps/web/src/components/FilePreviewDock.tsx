import { useEffect } from "react";
import { PREVIEW, clampPreview } from "../layout";
import { useStore } from "../store";
import { Resizer } from "./Resizer";
import { PreviewContent, closeFilePreview, expandFilePreview, useFilePreviewState } from "./FilePreview";

/**
 * 文件预览侧栏外壳（窗口够宽时放在聊天区右边；设计见 docs/design/file-preview-side-panel.md）。
 * 内容 / 工具栏复用 FilePreview 的 PreviewContent（和弹窗是同一个组件）。
 * 是否停靠、停靠宽度由 App 用 layout.ts 的 resolveLayout 算好传进来。
 */
export function FilePreviewDock({ docked, width }: { docked: boolean; width: number }) {
	const { item, expanded } = useFilePreviewState();
	const previewW = useStore((s) => s.layout.previewW);
	const setLayout = useStore((s) => s.setLayout);
	const show = !!item && docked && !expanded;
	// 当前助理 / 群 / 对话：变了就自动关（侧栏只在显示时挂载，所以只会在它打开期间触发）
	const ctx = useStore((s) => `${s.room ?? ""}|${s.current ?? ""}|${s.convs[s.current ?? ""]?.current ?? ""}`);
	useEffect(() => {
		if (show) closeFilePreview();
	}, [ctx]); // eslint-disable-line react-hooks/exhaustive-deps

	// Esc 关闭：在输入框 / 可编辑区域里打字时不关；已有弹层（设置、图片查看等）开着时让它们先处理
	useEffect(() => {
		if (!show) return;
		const k = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented) return;
			const t = e.target as HTMLElement | null;
			if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
			if (document.querySelector(".pa-modal, [data-testid=image-viewer]")) return;
			closeFilePreview();
		};
		addEventListener("keydown", k);
		return () => removeEventListener("keydown", k);
	}, [show]);

	if (!show || !item) return null;
	return (
		<div className="pa-preview-wrap" data-testid="file-preview" data-docked="1" style={{ ["--preview-w" as string]: `${width}px` }}>
			<Resizer side="left" value={width} onChange={(v) => setLayout({ previewW: clampPreview(v) })} onReset={() => setLayout({ previewW: PREVIEW.def })} onCollapse={closeFilePreview} label="调整文件预览宽度" />
			<aside className="pa-preview" aria-label="文件预览">
				<PreviewContent key={item.url} item={item} onClose={closeFilePreview} onExpand={expandFilePreview} />
			</aside>
		</div>
	);
}
