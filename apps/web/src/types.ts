export interface Attachment { fileId: string; name: string; mime: string; size: number; direction?: string; workspacePath?: string | null }
/** 引用快照：服务端生成、客户端只读（镜像 packages/server/src/messages.ts 的 ReplySnapshot）。 */
export interface ReplySnapshot {
	messageId: string;
	author: { id: string; name: string; role: "user" | "assistant"; avatar?: string };
	source: { kind: "room" | "conversation"; id: string };
	excerpt: string;
	truncated: boolean;
	edited: boolean;
	attachments?: { fileId: string; name: string; mime: string; size: number }[];
	createdAt: number;
	unavailable?: boolean;
}
export interface Message {
	id: string; agent_id: string; conversation_id?: string | null; task_id: string | null;
	subagent_id?: string | null; role: "user" | "assistant" | "tool" | "system" | "card";
	content: string; meta: Record<string, any> & { attachments?: Attachment[] }; status: string; created_at: number; updated_at: number;
	room_id?: string | null; seq?: number;
	/** 引用的被引用消息 id（服务端可信解析；客户端只传 replyToId，不自填作者 / 摘录） */
	replyToId?: string | null;
	reply?: ReplySnapshot | null;
}
export interface Agent {
	id: string; name: string; avatar: string; color: string; persona: string; description: string; status: string; unread: number;
	model: { provider: string; id: string } | null; model_provider: string | null; model_id: string | null; workspace: string;
	last?: { content: string; role: string; created_at: number } | null;
	conversation_id?: string; memory_provider?: string | null; thinking?: string; thinkingSetting?: string | null; /** 请求级 Fast（OpenAI service_tier=priority）：独立于 thinking / 模型 */ fast?: boolean;
	/** user = 我的助理；room = 群专属助理（不在侧边栏） */
	scope?: "user" | "room"; room_id?: string | null;
}
export interface RoomMember { agentId: string; name: string; avatar: string; color: string; left: boolean; deleted: boolean; scope: string; status: string }
export interface RoomCaps { maxTurns: number; maxDepth: number; perAgent: number; followup: boolean }
export interface RoomState { running: boolean; current: { agentId: string; reason: string } | null; queue: string[] }
/** 项目方案（镜像服务端 rooms/plan.ts 的 ProjectPlan）：方案卡和项目面板共用。 */
export interface ProjectPlan {
	goal: string; doneCriteria: string; assumptions: string[];
	roles: { member: string; agentId?: string; does: string }[];
	stages: { name: string; output: string }[];
	checkpoints: string[]; deliverables: string; needs: string; scale: string;
}
export type ProjectStatus = "proposed" | "active" | "done" | "stopped" | "dismissed";
/** 进度清单里的一条任务（镜像服务端 rooms/progress.ts 的 ProgressItem）。 */
export interface ProgressItem { id: string; title: string; ownerName: string; status: string; statusLabel: string; waitingFor: string[] }
/** 项目进度清单（镜像服务端 rooms/progress.ts 的 ProjectProgress）：项目面板和顶部 chip 共用；方案待确认时没有这个字段。 */
export interface ProjectProgress {
	stages: { name: string; output: string; items: ProgressItem[]; state: "todo" | "doing" | "done" }[];
	other: ProgressItem[];
	done: number;
	total: number;
	currentStage: number | null;
}
/** 项目在等用户看一眼的关键点（镜像服务端项目的 waiting）：没有就是 null / 缺省。 */
export interface ProjectWaiting { checkpoint: string; message: string; options?: string[]; requestId?: string; at?: number }
export interface RoomProject {
	id: string; roomId: string; title: string; status: ProjectStatus; plan: ProjectPlan; draft: ProjectPlan | null;
	cardMessageId: string | null; summary: string | null; createdAt: number; confirmedAt: number | null; endedAt: number | null;
	/** 服务端还没有这个字段时为 undefined：界面按「没有进度清单」处理，不报错。 */
	progress?: ProjectProgress | null;
	/** 管理者请用户看一眼的关键点；服务端还没有这个字段时为 undefined（当作没有）。 */
	waiting?: ProjectWaiting | null;
}
/** 单聊里的项目（服务端 chat-projects/store.ts 的 ChatProjectJson）：和群聊项目同一形状，只是挂在对话上、没有 waiting。 */
export type ChatProject = Omit<RoomProject, "roomId"> & { conversationId: string };
export interface Room {
	/** 只含待确认 / 进行中的项目（按创建时间升序）；已结束的走 /api/rooms/:rid/projects?all=1 */
	projects?: RoomProject[];
	id: string; name: string; purpose: string; managerId: string | null; caps: RoomCaps; unread: number; paused: { reason: string } | null;
	members: RoomMember[]; last?: { content: string; role: string; agent_id: string; created_at: number } | null; created_at: number; updated_at: number; state: RoomState;
}
export interface Conversation { id: string; agent_id: string; title: string; created_at: number; updated_at: number; message_count: number; last: string | null }
export interface MemoryEntry { id: string; text: string; kind: "fact" | "experience" | "note"; scope: "user" | "agent" | "conversation" | "task"; status?: "draft" | "verified" | "promoted" | "legacy"; taskId?: string | null; createdAt: string; expiresAt: number | null; conversationId: string | null; source: string | null }
export interface MemoryProviderInfo { id: string; name: string; capabilities: { reflect: boolean; mentalModels: boolean; temporal: boolean; graph: boolean; exportImport: boolean; mcpEndpoint: boolean } }
export interface SkillMeta { id: string; name: string; description: string; source: "builtin" | "user" | "external"; builtin: boolean; updatedAt: number; size: number; enabledAgents: string[] }
export interface RoutineRun { id: string; routine_id: string; trigger: string; status: string; task_id: string | null; result: string | null; error: string | null; started_at: number; finished_at: number | null }
export interface Routine {
	id: string; agent_id: string; name: string; prompt: string; trigger: "cron" | "webhook"; cron: string | null; tz: string; quiet: { start: string; end: string } | null;
	status: "active" | "paused"; next_run_at: number | null; last_run_at: number | null; created_by: string | null; created_at: number; webhookPath: string | null; lastRun: RoutineRun | null;
}
/** 后台帮手（后台任务 / 定时任务的每次运行，决策 0014）：/api/subagents 一行里界面用到的字段 */
export interface Helper { id: string; agent_id: string; kind?: string | null; title?: string | null; task: string; status: string; result_summary: string | null; error_reason: string | null; created_at: number; finished_at: number | null }
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
	deviceId: string | null; onboarded: boolean; modelSetupDone?: boolean; modelReady?: boolean; defaultModel: { provider: string; providerName?: string; id: string; name?: string } | null; credentialBackend: string;
	sandbox: { mode: string; preference: string; dockerAvailable: boolean }; entryDomain: string | null; tunnel: TunnelStatus;
	workspaceRoot: string; push: { publicKey: string }; seq: number;
	app?: { version: string; builtAt?: string; launcher: string };
	/** 高级记忆健康；没人用高级记忆时为 null */
	memoryHealth?: { level: "ok" | "slow" | "failing"; summary: string } | null;
}
export interface Device { id: string; name: string; platform: string; status: string; created_at: number; last_seen_at: number | null; last_ip: string | null; owner?: number }
export interface CustomModel { id: string; api?: string; apiEffective?: string; baseUrlEffective?: string; name?: string; reasoning?: boolean; input?: ("text" | "image")[]; contextWindow?: number; maxTokens?: number; limitsSource?: "detected" | "known" | "default" | "user" | "learned"; detectedType?: "classifier"; classifierProtocol?: string }
/** 声明的 classifier（协议 + 对端模型 id）；保存后由服务端在启动/reload 时重新注册。 */
export interface CustomClassifier { protocol: string; modelId: string; name?: string; contextWindow?: number }
export interface CustomProviderMeta { id: string; name: string; api: string; baseUrl: string; headerNames: string[]; noKey: boolean; models: CustomModel[]; classifiers?: CustomClassifier[]; discoveredClassifiers?: CustomClassifier[]; protocolUrls?: Record<string, string>; configured: boolean; references?: ProviderReferences }
export interface ProviderReferences { defaultModel: boolean; visionModel: boolean; agents: string[]; subagents: boolean; subagentAgents: string[]; imageProviders?: string[] }

// ---- 统一模型服务（对齐 registry agent 契约：packages/server/src/model-registry.ts）----
export type ModelCapability = "chat" | "vision" | "image" | "classifier";
export type ModelType = "chat" | "image" | "classifier";
export type RegistryModelSource = "pi-catalog" | "custom" | "imagegen" | "guess" | "local";
/** 生图模型适配器：统一服务不再有独立生图凭据，凭据就是 provider 的凭据。 */
export interface ImageAdapter {
	kind: "openai" | "dashscope" | "ark" | "gemini" | "xai";
	baseUrl: string;
	edit: boolean;
	costNote?: string;
}
export interface RegistryModel {
	provider: string;
	id: string;
	name: string;
	type: ModelType;
	capabilities: ModelCapability[];
	protocol: string;
	confirmed: boolean;
	inferred: ModelCapability[];
	/** 分类器条目是自动识别的（对端元数据 / Pi 官方目录同 id），不是用户显式声明。 */
	discovered?: boolean;
	source: RegistryModelSource;
	configured: boolean;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input?: string[];
	edit?: boolean;
	costNote?: string;
	/** 本地服务（如 local-laya）的安全运行状态（不含凭据）。 */
	local?: { installed: boolean; running: boolean; state: string; device: string | null };
	/** 仅 type=image：生图适配器（迁移期由旧生图服务补齐）。 */
	imageAdapter?: ImageAdapter;
}
export interface RegistryProvider {
	id: string;
	name: string;
	kind: "builtin" | "custom" | "imagegen" | "local";
	configured: boolean;
	baseUrl?: string;
	protocols: string[];
	models: RegistryModel[];
}
export interface PhaseDto {
	state: "idle" | "downloading" | "verifying" | "done" | "error" | "cancelled";
	percent: number;
	bytes?: number;
	total?: number;
	speed?: number;
	error?: string;
}

/** 任务详情里和这个任务有关的成员提问（服务端 GET /api/work-items/:id 的 asks；没有就是缺省）。 */
export interface WorkAsk { id: string; to: string; toName: string; from: string; fromName: string; kind: "question" | "upstream"; status: "open" | "answered" | "escalated" | "closed"; rounds: number; question: string; updatedAt: number }
