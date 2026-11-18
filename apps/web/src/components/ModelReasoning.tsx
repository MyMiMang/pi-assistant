/** 模型编辑共用的推理覆盖：使用现有三态元数据和 SDK 档位映射，不自行推断渠道能力。 */
import { THINKING_LEVEL_ORDER } from "@pi-assistant/shared";
import { useState } from "react";
import type { CustomModel } from "../types";
import { THINKING_LABEL } from "../thinking-slider";
import { Fold, Help, Input, Select } from "./ui";

export function ModelReasoning({ model, onChange }: { model: CustomModel; onChange: (patch: Partial<CustomModel>) => void }) {
	const [open, setOpen] = useState(false);
	const mode = model.reasoningAuto || model.reasoning === undefined ? "auto" : String(model.reasoning);
	const user = model.thinkingLevelSource === "user";
	const map = model.thinkingLevelMap;
	const empty = () => Object.fromEntries(THINKING_LEVEL_ORDER.map((level) => [level, null])) as Record<string, string | null>;
	return (
		<Fold title="高级：思考支持" hint={model.reasoning === undefined ? "未识别" : model.reasoning ? "支持" : "不支持"} open={open} onToggle={() => setOpen(!open)} testId="model-reasoning">
			<div className="min-w-0 space-y-3" data-testid="model-reasoning-editor">
				<p className="text-[11px] text-mut">只有渠道文档明确支持时才手动设置；自动识别不会为未知模型开放思考档位。</p>
				<Select value={mode} ariaLabel="思考支持" testId="reasoning-mode" options={[{ value: "auto", label: "自动识别" }, { value: "true", label: "支持" }, { value: "false", label: "不支持" }]} onChange={(v) => onChange({ reasoning: v === "auto" ? undefined : v === "true", reasoningAuto: undefined, thinkingLevelMap: undefined, thinkingLevelSource: undefined })} />
				{model.reasoning && <>
					<div className="flex items-center gap-1 text-xs">可用档位 <Help>按该渠道文档勾选已确认的档位，填写实际接受的值。未勾选的档位不会出现在选择器中。关闭也需要渠道支持，例如文档明确要求 none 时填写 none。最大档位不会自动开启。某些协议使用固定预算或独立开关，不使用这里的协议值；以渠道文档为准。</Help></div>
					<Select value={user ? "user" : "auto"} ariaLabel="思考档位来源" testId="reasoning-level-source" options={[{ value: "auto", label: "自动（参考同名目录）" }, { value: "user", label: "按渠道文档指定" }]} onChange={(v) => onChange({ thinkingLevelMap: v === "user" ? empty() : undefined, thinkingLevelSource: v === "user" ? "user" : undefined })} />
					{!user && <p className="text-[11px] text-mut" data-testid="reasoning-source-hint">{map ? "档位参考同名目录，尚未验证这个渠道实际接受的值。" : "暂无档位证据；选择器将使用 SDK 默认候选（关闭、极简、低、中、高），尚未验证渠道支持。"}</p>}
					{user && <div className="space-y-2">
						{THINKING_LEVEL_ORDER.map((level) => {
							const selected = typeof map?.[level] === "string";
							return <div key={level} className="flex min-w-0 items-center gap-2">
								<label className="flex w-20 shrink-0 items-center gap-2 text-xs"><input type="checkbox" checked={selected} data-testid={`reasoning-enabled-${level}`} onChange={(e) => onChange({ thinkingLevelMap: { ...empty(), ...map, [level]: e.target.checked ? "" : null }, thinkingLevelSource: "user" })} />{THINKING_LABEL[level]}</label>
								{selected && <Input className="min-w-0 flex-1" value={map?.[level] ?? ""} placeholder="渠道文档中的值" aria-label={`${THINKING_LABEL[level]}档协议值`} data-testid={`reasoning-value-${level}`} onChange={(e) => onChange({ thinkingLevelMap: { ...map, [level]: e.target.value }, thinkingLevelSource: "user" })} />}
							</div>;
						})}
						<p className="text-[11px] text-mut">请至少选择一个思考档位并填写对应值；关闭档单独按文档声明。</p>
					</div>}
				</>}
			</div>
		</Fold>
	);
}
