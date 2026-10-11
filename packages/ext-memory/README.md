# ext-memory

Pi 扩展：记忆。只依赖 `MemoryProvider` 接口（与存储后端无关）：

- `remember / recall / reflect / forget / list / update`
- 记忆库（bank）= 助理 + 可选对话；作用域 `user`（所有助理共享的用户事实）/ `agent` / `conversation`
- 种类 `fact`（资料，总是注入）/ `log`（按日日志）/ `note`（短期便签，自动过期）

服务端提供 `basic`（SQLite + FTS5）实现；以后可接入更高级的后端（如 Hindsight），扩展与 UI 不需要改。
