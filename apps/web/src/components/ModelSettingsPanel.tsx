import { useStore } from "../store";
import { registerWorkspace } from "../workspace";
import { ModelSettingsContent } from "./ModelSettingsContent";

/** 业务对象固定在打开时；工作区只持有视图，不拥有模型设置或保存队列。 */
export function openModelSettings(agentId: string) {
	const agent = useStore.getState().agents.find((item) => item.id === agentId);
	if (!agent) return;
	return registerWorkspace({ key: `settings:model:${agentId}`, title: `${agent.name} · 模型设置`, kind: "settings", testId: "workspace-model-settings",
		content: <div className="p-4" data-model-agent={agentId}><ModelSettingsContent agentId={agentId} /></div> });
}
