import { useStore } from "../store";
import { t } from "../i18n";

/** 高级记忆健康小圆点：变慢黄色、出问题红色，正常不显示（设置入口、设置里的「记忆」标签共用） */
export function MemoryHealthDot({ className = "" }: { className?: string }) {
	const h = useStore((s) => s.system?.memoryHealth);
	if (!h || h.level === "ok") return null;
	return (
		<span
			data-testid="memory-health-dot"
			data-level={h.level}
			title={t(h.summary)}
			className={`inline-block size-2 shrink-0 rounded-full ${h.level === "failing" ? "bg-red-500" : "bg-amber-500"} ${className}`}
		/>
	);
}
