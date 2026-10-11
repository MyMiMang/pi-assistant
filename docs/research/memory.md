# Pi Assistant 记忆模块调研与集成设计

> **决定更新（2026-10-11）：放弃 MemOS。** 记忆后端只做两个：basic（SQLite，已实现）和 Hindsight（高级）。Hindsight 的记忆 LLM、向量模型、重排序三者分别可选；必须使用我们自己的 uv 环境、数据目录、pg0 和动态端口，绝不连接用户已有的实例（见 DESIGN.md §5.19）。下文关于 MemOS 的内容仅作调研记录保留。

> 调研日期：2026-10-11（北京时间）。Star 数和最近提交时间取自当天的 GitHub API。跑分大多是厂商自己报的，同一张表里的分数测法不一样（裁判模型、问答模型、数据子集都不同），**不能直接横比**，只能看大致水平。

## 1. 结论（先说结果）

1. **Hindsight（vectorize-io/hindsight）是首选的高级记忆后端。** MIT 协议，可以免费商用、打包分发。效果最好，并且有学术合作方独立复现过。它本来就按 retain/recall/reflect 三个操作和“记忆库（bank）”来设计，跟我们“每个助理一个记忆库”的模型正好对得上。官方有 Node 的生命周期管理包（`@vectorize-io/hindsight-all`）和 TS 客户端，自带 MCP，**还已经有一个现成的 pi 原生扩展**（`hindsight-coding-agents install pi`）可以参考。代价是：它是 Python 服务，用内嵌 PostgreSQL（pg0），要作为附属进程（sidecar）运行。
2. **第二个可选后端：MemOS 本地插件（`@memtensor/memos-local-plugin`）。** MIT，纯 TypeScript，better-sqlite3 加本地向量模型，可以**直接在我们的 Node 进程里运行**，不用 Python 也不用另起服务。出自国内团队（MemTensor），中文生态好。缺点是版本还是 2.0.x-beta，API 主要为 OpenClaw/Hermes/DSH 这几个适配器设计，要包一层适配。
3. **内置“基础记忆”**：继续用我们自己的 SQLite（FTS5 全文检索，可选 sqlite-vec 向量检索），零依赖、离线可用。
4. **不建议**作为后端的：Letta（已经变成一整套 agent 运行环境，跟 Pi 职能重复）、Zep/Graphiti（要 Neo4j/FalkorDB，太重；Zep 社区版已停止）、Memobase（要 Postgres+Redis，2026-01 之后基本没再更新）、LangMem（绑定 Python LangGraph）、MemMachine（要 Neo4j）、Supermemory local（**服务端源码不公开**，是“lite license”授权的闭源二进制，不能随我们的程序分发）。
5. mem0 的 TS 开源 SDK（`mem0ai/oss`，Apache-2.0）也能在进程内用 SQLite 运行，可以作为备选第三后端。但它首页的 92.5/94.4 分是**托管平台**跑出来的，用了不开源的优化，开源版达不到这个分数。

## 2. 对比总表

| 项目 | 协议 | 语言/运行时 | 部署形态 | 纯本地 | 接口 | 记忆模型 | 跑分（来源） | 活跃度（2026-10-11） | 中文 | 能否用用户自己的模型/任意 OpenAI 兼容接口 |
|---|---|---|---|---|---|---|---|---|---|---|
| **Hindsight** | MIT ✅ | Python（服务端）+ TS/Python/Go 客户端 | 附属服务：pip/uv 安装，或 Docker；内嵌 PG（pg0），生产环境可接外部 PG+pgvector | ✅（大模型可以用 Ollama/LM Studio；向量和重排序可在本地跑） | REST、MCP（每个记忆库一个端点 `/mcp/{bank}`）、TS SDK、CLI、**pi 扩展** | 世界事实、经历、观察（会自动合并）、心智模型/知识页、实体图谱、时间维度、reflect 反思、性格倾向参数 | LongMemEval 91.4%、LoCoMo 89.61%（论文，Gemini-3 作答）；用开源 20B 模型时 83.6%；官网 AMB 榜单 LongMemEval-S 94.6%。弗吉尼亚理工和华盛顿邮报独立复现过 | 48.2k★，v0.10.3（10-08） | ✅ 自动识别语言，事实保留原文语言；但**默认向量模型是英文的**，要换成多语言模型 | ✅ 支持 25 种以上渠道，包括 deepseek、zai（智谱）、minimax、volcano（火山）、openrouter、ollama，`openai` 渠道加 `LLM_BASE_URL` 可以接任意兼容接口 |
| **MemOS**（含本地插件） | Apache-2.0（主仓库）/ MIT（本地插件）✅ | 主服务 Python；**本地插件是 TS** | 本地插件：进程内运行 + SQLite；完整版：Docker + Neo4j + Qdrant | ✅（本地插件） | 本地插件：进程内 `MemoryCore`、JSON-RPC 桥接、HTTP 查看器；完整版：REST | 三层：L1 原始轨迹、L2 策略、L3 世界模型；还有技能沉淀、混合检索（FTS5+向量）、去重 | LoCoMo 88.83、LongMemEval 89.20（官方 README，自报） | 11.8k★，10-10 有提交 | ✅✅ 国内团队，有中文文档 | ✅ 可以复用宿主程序配置的模型和凭据 |
| **mem0** | Apache-2.0 ✅ | Python + **TS 开源 SDK** | 库（进程内）、自托管服务、云服务；TS 版自带 better-sqlite3 向量存储 | ✅ | Python/TS SDK、REST、MCP（OpenMemory） | 事实抽取 + 增删改合并；可选图谱 | 托管平台 LoCoMo 92.5 / LongMemEval 94.4（官方 README 写明开源版达不到）；早期论文 LoCoMo 66.9 / 加图谱 68.4（arXiv 2504.19413） | 67k★，10-09 | 一般（取决于所用模型） | ✅ 支持 openai/deepseek/ollama/lmstudio/vllm/litellm 等，可改 baseURL |
| **Letta**（原 MemGPT） | Apache-2.0 ✅ | 现在主体是 TS（letta-code） | 完整的 agent 运行环境和应用服务 | ✅ | Agent SDK、服务端 | 核心记忆块、归档记忆、自主编辑记忆 | 新版 README 没给出 LoCoMo/LME 分数 | letta 仓库已转为存档，新代码在 letta-code（3.6k★） | 一般 | ✅ |
| **Graphiti / Zep** | Apache-2.0 ✅（Zep 云服务闭源） | Python | 要 Neo4j/FalkorDB/Neptune；Kuzu 驱动已弃用 | ✅（自己搭图数据库） | Python 库、MCP 服务 | **双时间轴知识图谱**（事实有效期）、实体/边 | Zep+GPT-4o 在 LongMemEval 71.2%（arXiv 2501.13956）；LoCoMo 75.14（Backboard 榜单转引） | Graphiti 31.6k★，10-10 | 一般 | ✅ OpenAI 兼容 |
| **Cognee** | Apache-2.0 ✅（Postgres 图存储的生产版要商业授权） | Python 3.10–3.14 | 库/Docker；默认 SQLite + 本地向量库 + 图数据库 | ✅（没有大模型也能用 GLiNER 抽取） | Python、REST、MCP、TS SDK | 知识图谱 + 向量、本体、会话反馈 | 只报了 BEAM（自报） | 32k★，10-09 | 有中文 README | ✅ 通过 litellm/Ollama |
| **Memobase** | Apache-2.0 ✅ | Python（FastAPI） | Postgres + Redis，Docker | ✅ | REST、Python/TS SDK | 用户画像 + 事件时间线 | LoCoMo 75.78（自报 v0.0.37） | 2.9k★，**2026-01 后无更新** | 一般 | ✅ |
| **LangMem** | MIT ✅ | Python（LangGraph） | 库，依赖 LangGraph Store | ✅ | Python | 语义/情景/程序性记忆、提示词优化 | LoCoMo 58.10（Backboard 榜单转引） | 1.7k★ | 一般 | ✅ |
| **MemMachine** | Apache-2.0 ✅ | Python | Neo4j + SQL，Docker | ✅ | REST、MCP、Python/TS SDK | 情景记忆（图）+ 用户画像 | — | 3.1k★，10-10 | 一般 | ✅ |
| **Supermemory local** | ⚠️ 仓库是 MIT，但**本地服务端源码不公开**，用 lite license 授权 | 闭源二进制 | 单个二进制文件 | ✅（网址抓取要走它的云服务） | REST、TS SDK、MCP | 记忆 + 用户画像 + 图谱 | 自称在 LME/LoCoMo 排第一（Recall@15 95%） | 31k★ | 有中文 README | ✅ |
| basic-memory | ❌ **AGPL-3.0** | Python | — | — | MCP | Markdown 知识库 | — | 4.1k★ | — | — |

协议需要注意的地方：没有 BSL/FSL 协议的项目。**basic-memory 是 AGPL**，不能打包分发；**Supermemory local 是闭源授权**，不能打包；**Cognee 的 Postgres 图存储生产版要商业授权**，默认存储方式不受影响。

## 3. Hindsight 深入分析

- **仓库**：https://github.com/vectorize-io/hindsight （MIT，48k★，v0.10.3，2026-10-08 发布，Vectorize.io 维护，有付费云服务，开源版功能完整）
- **三个核心操作**：`retain`（用大模型抽取事实、实体、时间、因果关系，并建立图谱链接）、`recall`（语义检索、BM25 关键词、图遍历、时间范围四路并行，用 RRF 融合，再经交叉编码器重排序，按 token 预算截断）、`reflect`（在记忆上做推理，结合记忆库的性格倾向参数，生成并更新“观点/信念”）。
- **观察和心智模型**：后台会把相关事实合并成“观察”（带证据引用和佐证次数）。心智模型是预先定义的固定问题（例如“这个用户有什么偏好？”），由后台自动维护答案，读取时**不调用大模型**，适合助理每次启动时注入。
- **TS 客户端 API**（@vectorize-io/hindsight-client 0.10.3）：`retain/retainBatch/retainFiles/recall/reflect/createBank/deleteBank/cloneBank/exportBank/importBank/listMemories/deleteDocument/createMentalModel/getMentalModel/refreshMentalModel/setMission/updateBankConfig/...`。导出/导入接口为在不同后端之间迁移记忆提供了基础。
- **嵌入到 Node 程序**：`@vectorize-io/hindsight-all`（Node 22 以上）负责管理 `hindsight-embed` 守护进程（通过 `uvx` 拉起），提供 `start/stop/checkHealth/getBaseUrl`，`env` 可以透传任意 `HINDSIGHT_API_*` 配置。
- **资源占用**（官方安装文档）：
  - 完整版（自带 BGE 向量模型和 MiniLM 重排序模型，依赖 PyTorch）：空闲内存约 0.8–1.0 GB，负载时 1.2–1.5 GB；Docker 镜像约 9 GB（压缩后 3.7 GB）。
  - 精简版：内存 512 MB–1 GB，镜像约 500 MB，向量和重排序要用外部服务，或者用进程内 ONNX（`hindsight-api-slim[local-onnx]`）。
  - 内置 PG（pg0）另外占 512 MB 以上。
  - Intel Mac 只能用精简版。
- **中文**：`retain/reflect` 保留原文语言（“张伟”不会被翻成 Zhang Wei）。但默认向量模型 `BAAI/bge-small-en-v1.5` 和默认重排序模型 `ms-marco-MiniLM-L-6-v2` 都是英文模型。**中文场景必须改成**：
  - 向量：`EMBEDDINGS_PROVIDER=onnx`，模型用 `intfloat/multilingual-e5-small`（384 维，ONNX 默认）或 `BAAI/bge-m3`（1024 维，效果更好）。
  - 重排序：`siliconflow` 或 `alibaba`（国内的重排序服务），或者 `flashrank`（本地 ONNX），或者 `rrf`（不做重排序）。
  - BM25 可以选 vchord 的多语言分词器。
- **模型渠道**：`openai`、`openai-responses`、`anthropic`、`gemini`、`deepseek`、`zai`、`minimax`、`volcano`、`openrouter`、`ollama`、`lmstudio`、`llamacpp`、`litellm`，以及订阅类的 `openai-codex`、`claude-code`、`github-copilot` 等。`openai` 渠道加 `HINDSIGHT_API_LLM_BASE_URL` 可以接任意兼容 OpenAI 的接口。还能给 retain 单独指定一个模型（`HINDSIGHT_API_RETAIN_LLM_*`）。
- **其他**：每个记忆库可以开启“Memory Defense”，自动脱敏 45 类密钥和个人信息；有 webhook、Prometheus 监控、管理用的 CLI。
- **风险**：
  1. 依赖 Python，首次运行要下载 Python 依赖和模型，国内网络要配 PyPI/HuggingFace 镜像。
  2. pg0 官方标注“不建议用于生产”，对单人桌面使用可以接受，但要做好备份和导出。
  3. 每次 retain 都要调用大模型，有 token 成本。
  4. 更新很快（10 天发 3 个版本），要锁定版本，并通过我们的自动升级流程验证后再推给用户。

## 4. 推荐方案

| 档位 | 后端 | 适合谁 | 安装成本 |
|---|---|---|---|
| 基础记忆（默认） | 内置 SQLite（FTS5，可选 sqlite-vec） | 所有人，离线可用 | 0 |
| 高级记忆（推荐） | **Hindsight** | 想要最强记忆、反思和长期学习的用户 | 首次开启时下载约 300–600 MB（精简版 + ONNX），常驻内存约 1–1.5 GB |
| 高级记忆（轻量，第二批再做） | MemOS 本地插件 | 不想装 Python、机器配置低、偏国内生态的用户 | npm 依赖加本地向量模型，约 100–200 MB |

mem0 TS 开源版作为备用，先不在界面上开放，等需求出现再接。

## 5. 集成设计

### 5.1 MemoryProvider 接口（放在 `packages/server/src/memory/`）

```ts
export type BankId = string; // 规则：`agent_<agentId>`，同一用户的多个助理互相隔离

export interface MemoryItem {
  id: string; text: string; kind?: 'fact'|'experience'|'observation'|'opinion'|'note';
  createdAt: string; occurredAt?: string; score?: number; source?: { sessionId?: string; messageId?: string };
  meta?: Record<string, unknown>;
}

export interface MemoryCapabilities {
  reflect: boolean; mentalModels: boolean; temporal: boolean; graph: boolean;
  exportImport: boolean; mcpEndpoint: boolean;
}

export interface MemoryProvider {
  readonly id: 'basic' | 'hindsight' | 'memos' | string;
  readonly capabilities: MemoryCapabilities;
  init(ctx: ProviderContext): Promise<void>;          // 启动/连接（附属进程由 lifecycle 管理）
  health(): Promise<{ ok: boolean; detail?: string }>;
  ensureBank(bank: BankId, profile: { name: string; persona?: string; language?: string }): Promise<void>;
  remember(bank: BankId, input: { content: string; context?: string; timestamp?: string; documentId?: string; meta?: Record<string, unknown> }): Promise<{ ids?: string[]; async?: boolean }>;
  recall(bank: BankId, query: string, opts?: { tokenBudget?: number; limit?: number; timeRange?: [string, string] }): Promise<MemoryItem[]>;
  reflect?(bank: BankId, query: string): Promise<{ answer: string; citations?: MemoryItem[] }>;
  list(bank: BankId, opts?: { cursor?: string; limit?: number; q?: string }): Promise<{ items: MemoryItem[]; cursor?: string }>;
  forget(bank: BankId, target: { id?: string; documentId?: string; all?: boolean }): Promise<void>;
  bootContext?(bank: BankId): Promise<string>;        // 会话开始时注入的“已确定的认识”（Hindsight 用心智模型实现）
  export?(bank: BankId): Promise<MemoryExport>;        // 不同后端之间迁移用的统一 JSONL 格式
  import?(bank: BankId, data: MemoryExport): Promise<void>;
  shutdown(): Promise<void>;
}
```

- **记忆注册中心 `MemoryRegistry`**：每个助理可以单独选后端（默认跟随全局设置），切换后端时提示“导出旧记忆、导入新后端”。
- **Pi 扩展 `ext-memory`**：
  - 注册工具 `memory_remember`、`memory_recall`、`memory_reflect`、`memory_forget`。
  - 用 Pi 的会话钩子做两件事：会话开始前注入 `bootContext()`，加上对用户第一句话 `recall` 出的 top-K 记忆；每轮对话结束后，把这一轮的对话（user + assistant + 关键工具结果的摘要）**异步** `remember`，不阻塞回复。
  - 所有调用只通过 MemoryProvider 接口，Pi 和后端都可以独立升级。
- **界面**：助理信息面板加“记忆”页，可以浏览、搜索、删除、导出记忆，后端有心智模型时也一起展示。设置页加“记忆后端”选项、健康状态和资源占用。
- **安全**：调用 `remember` 前先过一遍我们自己的密钥扫描（Hindsight 再开启 Memory Defense 做第二道）；`forget(all)` 要走审批卡片确认。

### 5.2 基础 SQLite 后端（basic）

- 表结构：`memories(id, bank, text, kind, created_at, occurred_at, source_json, meta_json, embedding BLOB NULL)`，配一张 FTS5 虚表。
- `remember`：默认由主模型通过 `memory_remember` 工具**显式写入**（不另外调用大模型抽取，省钱）；可选开启“每轮自动总结一条”。
- `recall`：FTS5 的 BM25 排序，加上时间衰减。如果用户配置了向量接口或者开启了本地向量（transformers.js 的 multilingual-e5-small），就和向量结果做 RRF 融合。中文分词用 FTS5 的 `trigram` 分词器（不需要额外依赖）。
- `reflect`：不支持，界面上置灰。

### 5.3 Hindsight 后端

**运行方式（按优先级）：**
1. **附属进程，默认方式，不依赖 Docker**：安装包里带上 `uv` 二进制（MIT/Apache 协议，单个文件约 30 MB）。用户第一次开启高级记忆时，由 `@vectorize-io/hindsight-all` 的 `HindsightServer` 拉起 `hindsight-embed`。版本固定为 `hindsight-api-slim[local-onnx]==<锁定版本>`，用 `embedPackagePath` 或额外参数指定，profile 名为 `pi-assistant`，端口随机，只绑定 127.0.0.1，数据目录放在 `<我们的数据目录>/memory/hindsight`（用环境变量把 pg0 的数据重定向到这里，方便备份和卸载）。
   - 国内网络：设置 `UV_INDEX_URL`（清华/阿里 PyPI 镜像）、`UV_PYTHON_INSTALL_MIRROR`、`HF_ENDPOINT=https://hf-mirror.com`，设置页可以切换。
   - 也可以在打包时直接把 Python 运行环境、依赖和 ONNX 模型一起放进安装包（会增加约 300–500 MB），实现完全离线安装。可以作为“完整离线版”安装包另外提供。
2. **Docker 方式（可选）**：检测到 Docker 时可以改用 `ghcr.io/vectorize-io/hindsight:<锁定版本>-slim`，数据卷持久化，适合已经在用 Docker 沙箱的用户。
3. **远程方式**：填写一个已有的 Hindsight 服务地址和 key（自己搭的服务器或 Hindsight Cloud），不启动本地进程。

**生命周期**（由我们的服务管理）：
- `MemoryLifecycle` 负责按需启动；用 `checkHealth` 做健康检查；崩溃时按指数退避重启；我们的服务退出时调用 `stop()`。
- 关闭 hindsight-embed 默认的“空闲 5 分钟自动退出”，或者交给我们统一管理。
- 首次下载的进度推送到界面上显示。
- 启动失败时自动降级到基础记忆，并在界面提示。retain 失败时先写进本地 outbox 表，恢复后补发，保证不丢数据。

**复用用户的模型凭据（关键）**：
- **方案 A，推荐**：我们的服务内部开一个只对本机开放的 **OpenAI 兼容网关** `http://127.0.0.1:<port>/internal/llm/v1`（实现 `/chat/completions`），背后调用 Pi 的 `pi-ai` 模型接口，用的是用户在向导里配置好的渠道（43 个 Pi 渠道、自定义中转站、订阅登录都可以）。Hindsight 的配置是 `HINDSIGHT_API_LLM_PROVIDER=openai`，`LLM_BASE_URL` 指向这个网关，`LLM_API_KEY` 用每次启动随机生成的令牌。这样**密钥永远只存在我们的密钥存储里，不会写进 Hindsight 的配置文件**，用户换模型也不用重启 Hindsight。网关要处理好 `response_format=json_object`/`json_schema`：渠道支持就透传，不支持就把 schema 写进提示词；同时配合 `HINDSIGHT_API_LLM_STRICT_SCHEMA` 和 `LLM_OPENAI_COMPATIBLE_JSON_MODE` 调参。
- **方案 B，直连**：如果用户的渠道正好是 Hindsight 原生支持的（openai、anthropic、deepseek、zai、minimax、volcano、openrouter、ollama……），可以把 provider、base_url、key 通过 `env` 直接映射过去，少一跳转发。
- 设置页可以单独选一个“记忆用模型”（建议选便宜、快的模型，例如 deepseek-v4-flash 或小号 GPT），对应 `HINDSIGHT_API_RETAIN_LLM_*`。
- 向量和重排序默认在本地用 ONNX（multilingual-e5-small，加 flashrank 或 rrf），不需要额外的 key。用户如果有硅基流动或阿里云百炼，可以切换成远程重排序或向量服务，效果更好。

**映射关系**：
- 助理对应记忆库 `agent_<id>`，助理的性格设定写进记忆库的 mission 和性格倾向参数。
- 创建记忆库时默认建两个心智模型：“用户偏好与习惯”和“进行中的事项与约定”，用作 `bootContext()`。
- `forget` 对应 `deleteDocument`（我们在 retain 时写入 `documentId = session:<sid>:turn:<n>`），清空整个记忆库对应 `deleteBank` 再重建。
- `export/import` 对应 `exportBank/importBank`。

**MCP 的用法**：Hindsight 每个记忆库都有一个 `/mcp/{bank}` 端点，可以作为“高级用法”提供给用户自己的外部工具（例如 Claude Code）共享同一个记忆库。但 Pi 内部**不走 MCP**，而是走 TS SDK，因为这样能拦截、审计，还能离线补发。

### 5.4 MemOS 本地插件（第二批）

- 在我们的进程里直接 `import { MemoryCore }`（`dist/core`），参照它的 `adapters/openclaw` 写一个 `adapters/pi-assistant`：模型调用同样走上面那个网关，SQLite 文件放在 `<数据目录>/memory/memos/memos.db`。
- 它自带的查看器（127.0.0.1:18801）可以嵌进“记忆”页。
- 注意：它依赖 better-sqlite3、onnxruntime-node、sharp 这些原生模块，需要在 CI 里为 mac-arm64/x64 和 win-x64 分别预编译。

### 5.5 升级路径

- 版本锁定统一写在 `deps.lock.json` 里，包括 `hindsight-api-slim`、`@vectorize-io/hindsight-client`、`@vectorize-io/hindsight-all`、`@memtensor/memos-local-plugin`，纳入每周自动升级的 PR 流程。
- CI 契约测试：启动 Hindsight，依次跑 retain → recall → reflect → deleteDocument → exportBank/importBank，用的是模拟大模型网关加中文样例，测试通过才合并。
- 用户这边升级时，先导出记忆再升级（Hindsight 启动时会自动迁移 PG 的表结构）；升级失败就回滚到上个版本，因为 `uv` 缓存里还保留着旧版本。
- 换向量模型需要重新生成全部向量：界面上提示，任务在后台跑。

### 5.6 落地顺序

1. 写 MemoryProvider 接口、基础 SQLite 后端、`ext-memory` 扩展和记忆页（第二阶段内完成）。
2. 写模型网关，接入 Hindsight（附属进程加国内镜像），完成自动注入和自动保存、心智模型、导出导入。
3. 接入 MemOS 本地插件；mem0 视需求再定。

## 6. 资料来源

- Hindsight 仓库/README：https://github.com/vectorize-io/hindsight
- Hindsight 论文：https://arxiv.org/abs/2512.12818 （LongMemEval 91.4%、LoCoMo 89.61%，开源 20B 模型 83.6%）
- Hindsight 跑分榜：https://benchmarks.hindsight.vectorize.io/
- Hindsight 安装和资源占用：https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/docs/developer/installation.md
- Hindsight 配置（向量、重排序、渠道）：https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/docs/developer/configuration.mdx
- Hindsight 多语言：https://hindsight.vectorize.io/developer/multilingual
- Hindsight Node 嵌入包：https://github.com/vectorize-io/hindsight/tree/main/hindsight-all-npm
- Hindsight pi 扩展：https://github.com/vectorize-io/hindsight/tree/main/hindsight-integrations/coding-agents
- MemOS：https://github.com/MemTensor/MemOS ；本地插件：https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin
- mem0：https://github.com/mem0ai/mem0 ；TS SDK：https://github.com/mem0ai/mem0/tree/main/mem0-ts ；论文 https://arxiv.org/abs/2504.19413
- Letta：https://github.com/letta-ai/letta → https://github.com/letta-ai/letta-code
- Graphiti：https://github.com/getzep/graphiti ；Zep 论文 https://arxiv.org/abs/2501.13956
- Cognee：https://github.com/topoteretes/cognee
- Memobase：https://github.com/memodb-io/memobase
- LangMem：https://github.com/langchain-ai/langmem
- MemMachine：https://github.com/MemMachine/MemMachine
- Supermemory：https://github.com/supermemoryai/supermemory ；本地版与企业版对比：https://supermemory.ai/docs/self-hosting/local-vs-enterprise
- basic-memory（AGPL）：https://github.com/basicmachines-co/basic-memory
