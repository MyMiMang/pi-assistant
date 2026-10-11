export interface Attachment { fileId: string; name: string; mime: string; size: number; direction?: string; workspacePath?: string | null }
export interface Message {
	id: string; agent_id: string; task_id: string | null; role: "user" | "assistant" | "tool" | "system" | "card";
	content: string; meta: Record<string, any> & { attachments?: Attachment[] }; status: string; created_at: number; updated_at: number;
}
export interface Agent {
	id: string; name: string; avatar: string; color: string; persona: string; description: string; status: string; unread: number;
	model: { provider: string; id: string } | null; model_provider: string | null; model_id: string | null; workspace: string;
	last?: { content: string; role: string; created_at: number } | null;
}
export interface Task { id: string; agent_id: string; title: string; instructions: string; status: string; result: string | null; error: string | null; created_at: number; finished_at: number | null }
export interface Provider { id: string; name: string; apiKey?: { name: string }; oauth?: { name: string; isSubscription: boolean; loginLabel?: string }; modelCount: number; configured: boolean; source?: string; custom?: boolean }
export interface ModelInfo { provider: string; id: string; name: string; reasoning: boolean; input: string[]; contextWindow?: number }
export interface TunnelStatus { enabled: boolean; state: string; url: string | null; error?: string; rendezvous: { state: string; at?: number; error?: string }; binary: string | null }
export interface SystemInfo {
	serverId: string; publicKey: string; pi: { version: string; testedWith: string; compatible: boolean; message: string }; mock: boolean; local: boolean;
	deviceId: string | null; onboarded: boolean; modelSetupDone?: boolean; defaultModel: { provider: string; id: string } | null; credentialBackend: string;
	sandbox: { mode: string; preference: string; dockerAvailable: boolean }; entryDomain: string | null; tunnel: TunnelStatus;
	workspaceRoot: string; push: { publicKey: string }; seq: number;
}
export interface Device { id: string; name: string; platform: string; status: string; created_at: number; last_seen_at: number | null; last_ip: string | null }
export interface CustomModel { id: string; name?: string; reasoning?: boolean; input?: ("text" | "image")[]; contextWindow?: number; maxTokens?: number }
export interface CustomProviderMeta { id: string; name: string; api: string; baseUrl: string; headerNames: string[]; noKey: boolean; models: CustomModel[]; configured: boolean }
