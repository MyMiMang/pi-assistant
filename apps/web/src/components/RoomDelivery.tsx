import { PackageCheck } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { Attachment, Message } from "../types";
import Attachments from "./Attachments";
import { PlanSection } from "./RoomCards";

/** 一段文字最多露出 6 行，超出的折叠，点「展开」看全（交付内容可能很长，不能整段铺满群聊）。 */
function ClampedText({ text, testId }: { text: string; testId: string }) {
	const ref = useRef<HTMLParagraphElement>(null);
	const [open, setOpen] = useState(false);
	const [over, setOver] = useState(false);
	useLayoutEffect(() => {
		const el = ref.current;
		if (el && !open) setOver(el.scrollHeight > el.clientHeight + 1);
	}, [text, open]);
	return (
		<>
			<p ref={ref} data-testid={testId} style={open ? undefined : { display: "-webkit-box", WebkitLineClamp: 6, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{text}</p>
			{over || open ? (
				<button type="button" className="mt-1 text-xs text-accent" onClick={() => setOpen(!open)} data-testid="delivery-toggle">{open ? "收起" : "展开全部"}</button>
			) : null}
		</>
	);
}

/**
 * 交付卡（管理者 room_project_done 之后系统在群里发的一张卡，meta.kind 为 project-delivery）：
 * 做成了什么、交付的文件（点开预览 / 下载）、怎么用、还没做的。不写花费。字段缺了就不显示那一块。
 */
export function ProjectDeliveryCard({ m }: { m: Message }) {
	const meta = m.meta;
	const summary = String(meta.summary ?? "").trim();
	const howToUse = String(meta.howToUse ?? "").trim();
	const notDone = String(meta.notDone ?? "").trim();
	const files = (Array.isArray(meta.files) ? (meta.files as Attachment[]) : []).filter((f) => f?.fileId);
	return (
		<div className="pa-card pa-plan w-full max-w-[560px]" data-testid="project-delivery" data-project={meta.projectId}>
			<div className="pa-card-top">
				<PackageCheck className="pa-ic accent" />
				<b>交付：{String(meta.title ?? "")}</b>
				<span className="pa-tag">已完成</span>
			</div>
			<div className="pa-plan-body">
				{summary && <PlanSection title="做成了什么"><ClampedText text={summary} testId="delivery-summary" /></PlanSection>}
				{files.length > 0 && (
					<PlanSection title={`交付的文件（${files.length}）`}>
						<div data-testid="delivery-files"><Attachments items={files.map((f) => ({ ...f, name: f.name || "文件", mime: f.mime ?? "", size: f.size ?? 0 }))} /></div>
					</PlanSection>
				)}
				{howToUse && <PlanSection title="怎么用 / 去哪看"><ClampedText text={howToUse} testId="delivery-howto" /></PlanSection>}
				{notDone && <PlanSection title="还没做的"><ClampedText text={notDone} testId="delivery-notdone" /></PlanSection>}
			</div>
		</div>
	);
}
