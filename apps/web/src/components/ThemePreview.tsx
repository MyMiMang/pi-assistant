import { Check } from "lucide-react";
import type { CSSProperties } from "react";
import type { Mode, ThemeDef } from "../themes/registry";

/** 主题实时预览：用真实的主题 CSS 渲染一个缩小版界面（data-skin / data-mode 作用在预览容器上）。 */
export function ThemePreview({ theme, mode, accent }: { theme: ThemeDef; mode: Mode; accent?: string }) {
	const style = (accent ? { "--acc": accent, "--acc-soft": `color-mix(in srgb, ${accent} 12%, transparent)` } : {}) as CSSProperties;
	return (
		<div className="pa-preview" data-skin={theme.id} data-mode={mode} style={style} aria-hidden="true">
			<div className="pa-app pa-preview-inner">
				<div className="pa-bg-layer">
					<i className="pa-b1" />
					<i className="pa-b2" />
					<i className="pa-b3" />
				</div>
				<aside className="pa-sidebar" style={{ width: 150 }}>
					<div className="pa-brand">
						<span className="pa-logo">π</span>
						<span className="pa-brand-name">Pi</span>
					</div>
					<div className="pa-sec-label">我的助理</div>
					<div className="pa-agent active">
						<span className="pa-avatar" style={{ width: 26, height: 26, background: "var(--acc)" }} />
						<span className="pa-agent-txt">
							<b>小派</b>
							<small>正在工作</small>
						</span>
					</div>
					<div className="pa-agent">
						<span className="pa-avatar" style={{ width: 26, height: 26, background: "var(--mut2)" }} />
						<span className="pa-agent-txt">
							<b>研究员</b>
							<small>资料与报告</small>
						</span>
					</div>
				</aside>
				<main className="pa-chat">
					<div className="pa-thread-body" style={{ padding: "18px 18px 0", gap: 12 }}>
						<div className="pa-msg user">
							<div className="pa-bubble">整理竞品定价发团队</div>
						</div>
						<div className="pa-msg bot">
							<div className="pa-bot-body" style={{ gap: 9 }}>
								<div className="pa-bubble">好，我先看一下。</div>
								<div className="pa-activity">
									<span className="pa-spinner" />
									<span className="pa-act-txt">
										<span className="pa-shimmer">正在打开网页…</span>
									</span>
								</div>
								<div className="pa-steps">
									<div className="pa-steps-head">
										<Check className="pa-ic ok" />
										<span>已完成 4 个步骤</span>
									</div>
								</div>
							</div>
						</div>
					</div>
					<div className="pa-composer-wrap" style={{ padding: "0 14px 12px" }}>
						<div className="pa-composer" style={{ padding: "8px 8px 8px 12px" }}>
							<div className="pa-composer-bar">
								<span className="text-[12px]" style={{ color: "var(--mut2)" }}>
									给小派布置任务…
								</span>
								<span className="flex-1" />
								<span className="pa-send" style={{ width: 26, height: 26 }} />
							</div>
						</div>
					</div>
				</main>
			</div>
		</div>
	);
}
