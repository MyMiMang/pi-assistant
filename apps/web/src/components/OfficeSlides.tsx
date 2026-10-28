import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Element as PptElement, Slide, Table, TableCell } from "pptxtojson";
import { PT_TO_PX, borderToCss, boxStyle, fillToCss, safeColor, safeDataImage, sanitizePptHtml, shadowToCss, slideScale } from "../office-preview";
import { ParseFail, ParseLoading, ShadowHost, useParsed } from "./OfficeParts";

/**
 * PPT 预览：pptxtojson 解析成 JSON，这里自己渲染（一页一张，按容器宽度等比缩放）。
 * 支持：文字（富文本经白名单清洗）、图片（base64）、形状（预设：矩形 / 圆 / 圆角 / 三角 / 直线；自定义路径用 SVG）及其填充 / 边框 / 阴影、表格、分组、
 * 公式图片、页背景（纯色 / 渐变 / 图片）。不支持：图表（占位「图表（下载查看）」）、视频 / 音频（占位）、SmartArt（只列文字）、动画 / 切换、
 * 图片裁剪与滤镜、文字自动缩放（autoFit）。设计见 docs/design/office-file-preview.md。
 */

const SHADOW_CSS = `:host{display:block}*{box-sizing:border-box}p{margin:0}ul,ol{margin:0;padding-left:1.5em}a{color:#2563eb;text-decoration:underline}table{border-collapse:collapse}`;
const placeholderStyle: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "center", border: "1px dashed #9ca3af", color: "#6b7280", background: "rgba(156,163,175,.12)", fontSize: 14, textAlign: "center", padding: 8 };

function Placeholder({ el, text }: { el: PptElement; text: string }) {
	return <div style={{ ...boxStyle({ ...el, rotate: 0 }), ...placeholderStyle }}>{text}</div>;
}

const alignOf = (v: string | undefined) => (/mid|ctr|cent/i.test(v ?? "") ? "center" : /down|bot|^b$/i.test(v ?? "") ? "flex-end" : "flex-start");

type TextLike = { content?: string; vAlign?: string; wrap?: boolean; isVertical?: boolean; textInset?: { l: number; t: number; r: number; b: number } };
function RichText({ el }: { el: TextLike }) {
	const inset = el.textInset;
	const pad = inset ? `${inset.t * PT_TO_PX}px ${inset.r * PT_TO_PX}px ${inset.b * PT_TO_PX}px ${inset.l * PT_TO_PX}px` : "3.6px 7.2px";
	return (
		<div
			style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", justifyContent: alignOf(el.vAlign), padding: pad, overflow: "hidden", ...(el.wrap === false ? { whiteSpace: "nowrap" } : { overflowWrap: "anywhere" }), ...(el.isVertical ? { writingMode: "vertical-rl" } : {}) }}
			dangerouslySetInnerHTML={{ __html: sanitizePptHtml(el.content ?? "") }}
		/>
	);
}

type Visual = { fill?: Parameters<typeof fillToCss>[0]; borderColor?: string; borderWidth?: number; borderType?: string; shadow?: Parameters<typeof shadowToCss>[0] };
const visualStyle = (e: Visual): CSSProperties => ({ ...fillToCss(e.fill), border: borderToCss(e), boxShadow: shadowToCss(e.shadow) });

const PATH_OK = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]+$/;
const dashOf = (t?: string) => (t === "dashed" ? "6 4" : t === "dotted" ? "1.5 3" : undefined);

function ShapeEl({ el }: { el: Extract<PptElement, { type: "shape" }> }) {
	const hasText = !!el.content && /[^\s]/.test(el.content.replace(/<[^>]*>/g, ""));
	const box = boxStyle(hasText ? { ...el, isFlipH: false, isFlipV: false } : el);
	const w = (el.width || 0) * PT_TO_PX;
	const h = (el.height || 0) * PT_TO_PX;
	const stroke = safeColor(el.borderColor);
	const sw = Math.max((el.borderWidth || 0) * PT_TO_PX, stroke ? 0.5 : 0);
	const fillCss = fillToCss(el.strokeOnly ? undefined : el.fill);
	const solid = fillCss.backgroundColor ?? (fillCss.background?.match(/#[0-9a-f]{3,8}|rgba?\([^)]*\)/i)?.[0] ?? "none");
	let body: React.ReactNode = null;
	let css: CSSProperties = {};
	if (el.path && el.pathViewBox && PATH_OK.test(el.path)) {
		const vb = el.pathViewBox;
		body = (
			<svg width="100%" height="100%" viewBox={`${vb.x} ${vb.y} ${vb.width || 1} ${vb.height || 1}`} preserveAspectRatio="none" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
				<path d={el.path} fill={solid} stroke={stroke ?? "none"} strokeWidth={sw} strokeDasharray={dashOf(el.borderType)} vectorEffect="non-scaling-stroke" />
			</svg>
		);
	} else if (/line|connector/i.test(el.shapType ?? "") || ((w < 1 || h < 1) && el.type === "shape")) {
		body = (
			<svg width="100%" height="100%" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
				<line x1="0" y1="0" x2="100%" y2="100%" stroke={stroke ?? "#374151"} strokeWidth={sw || 1} strokeDasharray={dashOf(el.borderType)} />
			</svg>
		);
	} else {
		css = visualStyle({ ...el, fill: el.strokeOnly ? undefined : el.fill });
		if (el.shapType === "ellipse") css.borderRadius = "50%";
		else if (/^round/i.test(el.shapType ?? "")) css.borderRadius = Math.min(w, h) * 0.1667;
		else if (el.shapType === "triangle") css.clipPath = "polygon(50% 0,100% 100%,0 100%)";
	}
	return (
		<div style={{ ...box, ...css }}>
			{body}
			{hasText && <RichText el={el} />}
		</div>
	);
}

function cellBorder(b: { borderColor: string; borderWidth: number; borderType: string } | undefined) {
	return borderToCss(b ?? {});
}

function TableEl({ el }: { el: Table }) {
	const cells = (c: TableCell, key: number) => {
		if (c.hMerge || c.vMerge) return null;
		const col = safeColor(c.fillColor);
		return (
			<td
				key={key}
				colSpan={c.colSpan}
				rowSpan={c.rowSpan}
				style={{ padding: "2px 6px", verticalAlign: /mid|ctr/i.test(c.vAlign) ? "middle" : /down|bot/i.test(c.vAlign) ? "bottom" : "top", backgroundColor: col, color: safeColor(c.fontColor), fontWeight: c.fontBold ? 700 : undefined, borderTop: cellBorder(c.borders?.top), borderBottom: cellBorder(c.borders?.bottom), borderLeft: cellBorder(c.borders?.left), borderRight: cellBorder(c.borders?.right) }}
				dangerouslySetInnerHTML={{ __html: sanitizePptHtml(c.text ?? "") }}
			/>
		);
	};
	return (
		<table style={{ ...boxStyle({ ...el, rotate: 0 }), height: undefined, tableLayout: "fixed", fontSize: 14 }}>
			<colgroup>{(el.colWidths ?? []).map((w, i) => <col key={i} style={{ width: w * PT_TO_PX }} />)}</colgroup>
			<tbody>
				{(el.data ?? []).map((row, ri) => (
					<tr key={ri} style={{ height: (el.rowHeights?.[ri] ?? 0) * PT_TO_PX || undefined }}>
						{row.map(cells)}
					</tr>
				))}
			</tbody>
		</table>
	);
}

function El({ el }: { el: PptElement }) {
	switch (el.type) {
		case "text":
			return (
				<div style={{ ...boxStyle({ ...el, isFlipH: false, isFlipV: false }), ...visualStyle(el) }}>
					<RichText el={el} />
				</div>
			);
		case "shape":
			return <ShapeEl el={el} />;
		case "image": {
			const src = safeDataImage(el.base64);
			if (!src) return <Placeholder el={el} text="图片（下载查看）" />;
			return <img src={src} alt="" style={{ ...boxStyle(el), objectFit: "fill", border: borderToCss(el), borderRadius: el.geom === "ellipse" ? "50%" : undefined }} />;
		}
		case "table":
			return <TableEl el={el} />;
		case "chart":
			return <Placeholder el={el} text="图表（下载查看）" />;
		case "video":
			return <Placeholder el={el} text="视频（下载查看）" />;
		case "audio":
			return <Placeholder el={el} text="音频（下载查看）" />;
		case "diagram":
			return <Placeholder el={el} text={`SmartArt 图示：${(el.textList ?? []).join(" / ").slice(0, 200) || "（下载查看）"}`} />;
		case "math": {
			const src = safeDataImage(el.picBase64);
			return src ? <img src={src} alt={el.latex} style={boxStyle(el)} /> : <Placeholder el={el} text={el.text || el.latex || "公式（下载查看）"} />;
		}
		case "group":
			return (
				<div style={boxStyle(el)}>
					{sorted(el.elements).map((c, i) => <El key={c.id ?? i} el={c} />)}
				</div>
			);
		default:
			return null;
	}
}

const sorted = (els: PptElement[] | undefined) => [...(els ?? [])].sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));

function SlideView({ slide, w, h, scale, index }: { slide: Slide; w: number; h: number; scale: number; index: number }) {
	return (
		<figure style={{ margin: "0 auto 14px", width: w * scale }} data-testid="pptx-slide">
			<div style={{ position: "relative", width: w * scale, height: h * scale, overflow: "hidden", background: "#fff", boxShadow: "0 1px 6px rgba(0,0,0,.25)" }}>
				<div style={{ position: "absolute", left: 0, top: 0, width: w, height: h, transform: `scale(${scale})`, transformOrigin: "0 0", color: "#000", ...fillToCss(slide.fill) }}>
					{sorted(slide.layoutElements).map((e, i) => <El key={`l${e.id ?? i}`} el={e} />)}
					{sorted(slide.elements).map((e, i) => <El key={e.id ?? i} el={e} />)}
				</div>
			</div>
			<figcaption style={{ textAlign: "center", fontSize: 12, color: "#6b7280", marginTop: 4 }}>第 {index + 1} 页</figcaption>
		</figure>
	);
}

export function PptxView({ buf }: { buf: ArrayBuffer }) {
	const st = useParsed(async () => {
		const { parse } = await import("pptxtojson");
		return parse(buf, { imageMode: "base64", videoMode: "none", audioMode: "none" });
	}, [buf]);
	const wrap = useRef<HTMLDivElement>(null);
	const [cw, setCw] = useState(0);
	useEffect(() => {
		const el = wrap.current;
		if (!el) return;
		const ro = new ResizeObserver(() => setCw(el.clientWidth - 24));
		ro.observe(el);
		setCw(el.clientWidth - 24);
		return () => ro.disconnect();
	}, [st.s]);
	if (st.s === "loading") return <ParseLoading />;
	if (st.s === "fail") return <ParseFail message={st.message} />;
	const { slides, size } = st.v;
	const w = size.width * PT_TO_PX;
	const h = size.height * PT_TO_PX;
	const scale = slideScale(cw, size.width);
	return (
		<div ref={wrap} className="h-full overflow-y-auto overflow-x-hidden bg-hover/30 p-3" data-testid="file-preview-pptx">
			<ShadowHost testId="pptx-host">
				<style>{SHADOW_CSS}</style>
				{slides.map((s, i) => <SlideView key={i} slide={s} w={w} h={h} scale={scale} index={i} />)}
			</ShadowHost>
		</div>
	);
}
