/**
 * 记忆后端接口（见 docs/research/memory.md §5.1）。与存储无关：basic（SQLite）、Hindsight、MemOS 都实现它。
 * 记忆库（bank）规则：每个助理 `agent_<agentId>`；所有助理共享的“关于用户”的事实放在 `user`。
 */
export type BankId = string;

export interface MemoryItem {
	id: string;
	text: string;
	kind?: "fact" | "experience" | "observation" | "opinion" | "note";
	createdAt: string;
	occurredAt?: string;
	score?: number;
	source?: { sessionId?: string; messageId?: string };
	meta?: Record<string, unknown>;
}

export interface MemoryCapabilities {
	reflect: boolean;
	mentalModels: boolean;
	temporal: boolean;
	graph: boolean;
	exportImport: boolean;
	mcpEndpoint: boolean;
}

export interface ProviderContext {
	dataDir: string;
	log?: (msg: string) => void;
}

/** 后端之间迁移用的统一格式（JSONL 的每行一条） */
export interface MemoryExport {
	format: "pi-assistant-memory/1";
	bank: BankId;
	profile?: { name: string; persona?: string; language?: string };
	items: (MemoryItem & { documentId?: string })[];
}

export interface RememberInput {
	content: string;
	context?: string;
	timestamp?: string;
	documentId?: string;
	meta?: Record<string, unknown>;
	/** 同一账本内完全相同文本是否复用已有行（默认复用）。task 草稿传 false，避免不同任务的同文本草稿被账本去重吞成一行、跨任务串位。 */
	dedupe?: boolean;
}

/**
 * reflect 的作用域过滤（源端隔离）：必须在请求里显式限定允许进入反思的记忆范围，
 * 未限定范围一律拒绝（fail closed），不能先拿全库喂给模型再在下游删输出。
 *  - { all: true }：仅主会话/用户核验视角可用（能看到全部草稿）。
 *  - { tags, tagsMatch } / { tagGroups }：只允许命中这些 provenance tag 的记忆进入服务端上下文。
 */
export type ReflectScope =
	| { all: true }
	| { tags: string[]; tagsMatch?: "any" | "all" | "any_strict" | "all_strict" | "exact" }
	| { tagGroups: unknown[] };

export interface MemoryProvider {
	readonly id: "basic" | "hindsight" | "memos" | string;
	readonly name: string;
	readonly capabilities: MemoryCapabilities;
	init(ctx: ProviderContext): Promise<void>;
	health(): Promise<{ ok: boolean; detail?: string }>;
	ensureBank(bank: BankId, profile: { name: string; persona?: string; language?: string }): Promise<void>;
	remember(bank: BankId, input: RememberInput): Promise<{ ids?: string[]; async?: boolean }>;
	recall(bank: BankId, query: string, opts?: { tokenBudget?: number; limit?: number; timeRange?: [string, string] }): Promise<MemoryItem[]>;
	reflect?(bank: BankId, query: string, scope: ReflectScope): Promise<{ answer: string; citations?: MemoryItem[] }>;
	list(bank: BankId, opts?: { cursor?: string; limit?: number; q?: string }): Promise<{ items: MemoryItem[]; cursor?: string }>;
	forget(bank: BankId, target: { id?: string; documentId?: string; all?: boolean }): Promise<void>;
	/** 会话开始时注入的“已确定的认识” */
	bootContext?(bank: BankId): Promise<string>;
	export?(bank: BankId): Promise<MemoryExport>;
	import?(bank: BankId, data: MemoryExport): Promise<void>;
	/** basic 扩展：编辑一条（UI 用）；没有实现的后端用 forget + remember 代替 */
	update?(bank: BankId, id: string, patch: { text?: string; kind?: MemoryItem["kind"]; meta?: Record<string, unknown> }): Promise<MemoryItem | null>;
	shutdown(): Promise<void>;
}
