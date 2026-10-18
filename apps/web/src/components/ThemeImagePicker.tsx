import { useEffect, useRef, useState } from "react";
import type { ThemeImageRef } from "@pi-assistant/shared";
import type { Attachment } from "../types";
import { AttachButton, AttachTray, useAttachUploader } from "./Attachments";
import { Help } from "./ui";

/** 主题设计允许的图片 MIME：默认拒绝 SVG（不执行任意矢量脚本），只收常见位图。 */
const THEME_IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i;

export interface ThemeImagePickerProps {
	/** 复用已有附件上传（例如 `(f) => upload(agentId, f)`）；不传时禁用上传并给出提示。 */
	uploadFn?: (f: File) => Promise<Attachment>;
	/** 受控值：只带附件 id + 元数据，绝不带 base64 / 本地路径。 */
	value: ThemeImageRef[];
	onChange: (refs: ThemeImageRef[]) => void;
	disabled?: boolean;
}

/**
 * 主题设计的图片素材选择器（复用聊天附件的安全上传 + 预览）。
 * **首版只支持「仅作参考」**：图片只参与用户显式发起的那一轮 AI 请求，不写进主题、不随主题导出。
 * （manifest v1 保留了 `background` / `decor` 素材位，但主题引擎目前只用 enum 装饰、**不会把素材图绘成背景**，
 * 所以这里不提供这两个选项，避免界面承诺一个还没实现的能力。）
 */
export function ThemeImagePicker({ uploadFn, value, onChange, disabled }: ThemeImagePickerProps) {
	const { files, pending, uploading, error, addFiles, removePending } = useAttachUploader(uploadFn ?? (() => Promise.reject(new Error("未配置上传"))));
	const [localErr, setLocalErr] = useState("");
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;

	// 从已上传附件派生引用（只取白名单图片 MIME，一律 usage=reference，不写进主题）
	useEffect(() => {
		const refs: ThemeImageRef[] = files
			.filter((f) => THEME_IMAGE_MIME.test(f.mime))
			.map((f) => ({ attachmentId: f.fileId, mime: f.mime, bytes: f.size, usage: "reference" }));
		onChangeRef.current(refs);
	}, [files]);

	const pick = (list: FileList) => {
		setLocalErr("");
		const keep: File[] = [];
		for (const f of Array.from(list)) {
			if (/svg/i.test(f.type) || /\.svg$/i.test(f.name)) {
				setLocalErr("SVG 暂不支持（避免任意矢量脚本），请用 PNG / JPG / WebP。");
				continue;
			}
			if (!/^image\//i.test(f.type)) {
				setLocalErr("主题素材只接受图片（PNG / JPG / WebP / GIF 等）。");
				continue;
			}
			keep.push(f);
		}
		if (keep.length) void addFiles(keep);
	};

	return (
		<div className="space-y-2" data-testid="theme-image-picker">
			<div className="flex items-center gap-2">
				{/* 生成中只禁用不移除：按钮消失会让旁边的「?」挪到鼠标下、弹出说明挡住下面的操作 */}
				<AttachButton onFiles={pick} label="加图片" disabled={disabled} />
				<Help>
					图片**仅作参考**：只用于你这次发起的 AI 生成请求，帮你定配色 / 风格 / 材质 / 布局，不会写进主题、也不随主题导出。
					（把素材图真正绘成背景 / 装饰暂未支持，所以这里没有那两个选项；后续版本再说。）
					图片会像平时发附件一样上传到本机服务；带位置等 EXIF 的照片建议先处理。SVG 暂不支持。
				</Help>
				{!uploadFn && <span className="text-xs text-mut2">上传不可用（未配置助理）</span>}
			</div>
			{(error || localErr) && <div className="text-xs text-red-500">{localErr || error}</div>}
			<AttachTray files={files} pending={pending} uploading={uploading} onRemove={() => {}} onRemovePending={removePending} />
			{files.length > 0 && (
				<ul className="space-y-1">
					{files.map((f) => (
						<li key={f.fileId} className="flex items-center gap-2 text-xs">
							<span className="min-w-0 flex-1 truncate text-mut">{f.name}</span>
							<span className="rounded-full border border-line px-2 py-0.5 text-mut2" data-usage="reference">
								仅作参考
							</span>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
