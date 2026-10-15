export interface Attachment { fileId: string; name: string; mime: string; size: number; direction?: string; workspacePath?: string | null }
export interface Message {
	id: string; agent_id: string; conversation_id?: string | null; task_id: string | null;
	subagent_id?: string | null; role: "user" | "assistant" | "tool" | "system" | "card";
	content: string; meta: Record<string, any> & { attachments?: Attachment[] }; status: string; created_at: number; updated_at: number;
	room_id?: string | null; seq?: number;
}
export interface Agent {
	id: string; name: string; avatar: string; color: string; persona: string; description: string; status: string; unread: number;
	model: { provider: string; id: string } | null; model_provider: string | null; model_id: string | null; workspace: string;
	last?: { content: string; role: string; created_at: number } | null;
	conversation_id?: string; memory_provider?: string | null; thinking?: string; thinkingSetting?: string | null;
	/** user = 我的助理；room = 群专属助理（不在侧边栏） */
	scope?: "user" | "room"; room_id?: string | null;
}
export interface RoomMember { agentId: string; name: string; avatar: string; color: string; left: boolean; deleted: boolean; scope: string; status: string }
export interface RoomCaps { maxTurns: number; maxDepth: number; perAgent: number; tokenBudget: number; followup: boolean }
export interface RoomState { running: boolean; current: { agentId: string; reason: string } | null; queue: string[] }
export interface Room {
	id: string; name: string; purpose: string; managerId: string | null; caps: RoomCaps; unread: number; paused: { reason: string } | null;
	members: RoomMember[]; last?: { content: string; role: string; agent_id: string; created_at: number } | null; created_at: number; updated_at: number; state: RoomState;
}
export interface Conversation { id: string; agent_id: string; title: string; created_at: number; updated_at: number; message_count: number; last: string | null }
export interface MemoryEntry { id: string; text: string; kind: "fact" | "experience" | "note"; scope: "user" | "agent" | "conversation"; createdAt: string; expiresAt: number | null; conversationId: string | null; source: string | null }
export interface MemoryProviderInfo { id: string; name: string; capabilities: { reflect: boolean; mentalModels: boolean; temporal: boolean; graph: boolean; exportImport: boolean; mcpEndpoint: boolean } }
export interface SkillMeta { name: string; description: string; builtin: boolean; updatedAt: number; size: number }
export interface RoutineRun { id: string; routine_id: string; trigger: string; status: string; task_id: string | null; result: string | null; error: string | null; started_at: number; finished_at: number | null }
export interface Routine {
	id: string; agent_id: string; name: string; prompt: string; trigger: "cron" | "webhook"; cron: string | null; tz: string; quiet: { start: string; end: string } | null;
	status: "active" | "paused"; next_run_at: number | null; last_run_at: number | null; created_by: string | null; created_at: number; webhookPath: string | null; lastRun: RoutineRun | null;
}
export interface Task { id: string; agent_id: string; title: string; instructions: string; status: string; result: string | null; error: string | null; created_at: number; finished_at: number | null }
export interface Provider { id: string; name: string; apiKey?: { name: string }; oauth?: { name: string; isSubscription: boolean; loginLabel?: string }; modelCount: number; configured: boolean; source?: string; custom?: boolean }
export interface ModelInfo { provider: string; id: string; name: string; reasoning: boolean; input: string[]; contextWindow?: number }
export interface PermCheck { ok: boolean; zoneRead: boolean; tunnelRead: boolean; dnsRead: boolean; tunnelEdit: boolean | null; missing: string[]; hint?: string }
export interface TunnelStatus {
	enabled: boolean; state: "off" | "downloading" | "starting" | "online" | "error" | "cooldown" | "missing"; mode: "quick" | "named"; url: string | null; error?: string;
	nextRetryAt?: number; failures: number; rendezvous: { state: string; at?: number; error?: string }; binary: string | null;
	named: { hostname?: string; check?: PermCheck; error?: string };
}
export interface SystemInfo {
	serverId: string; publicKey: string; pi: { version: string; testedWith: string; compatible: boolean; message: string }; mock: boolean; local: boolean; owner?: boolean; server?: boolean;
	deviceId: string | null; onboarded: boolean; modelSetupDone?: boolean; defaultModel: { provider: string; providerName?: string; id: string; name?: string } | null; credentialBackend: string;
	sandbox: { mode: string; preference: string; dockerAvailable: boolean }; entryDomain: string | null; tunnel: TunnelStatus;
	workspaceRoot: string; push: { publicKey: string }; seq: number;
	app?: { version: string; builtAt?: string; launcher: string };
}
export interface Device { id: string; name: string; platform: string; status: string; created_at: number; last_seen_at: number | null; last_ip: string | null; owner?: number }
export interface CustomModel { id: string; name?: string; reasoning?: boolean; input?: ("text" | "image")[]; contextWindow?: number; maxTokens?: number; limitsSource?: "detected" | "known" | "default" | "user" | "learned" }
/** 声明的 classifier（协议 + 对端模型 id）；保存后由服务端在启动/reload 时重新注册。 */
export interface CustomClassifier { protocol: string; modelId: string; name?: string; contextWindow?: number }
export interface CustomProviderMeta { id: string; name: string; api: string; baseUrl: string; headerNames: string[]; noKey: boolean; models: CustomModel[]; classifiers?: CustomClassifier[]; configured: boolean; references?: ProviderReferences }
export interface ProviderReferences { defaultModel: boolean; visionModel: boolean; agents: string[]; subagents: boolean; subagentAgents: string[] }
