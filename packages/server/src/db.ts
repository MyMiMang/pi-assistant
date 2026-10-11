import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";

export const db = new DatabaseSync(config.dbPath);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT NOT NULL, color TEXT NOT NULL,
  persona TEXT NOT NULL DEFAULT '', model_provider TEXT, model_id TEXT,
  status TEXT NOT NULL DEFAULT 'idle', session_file TEXT, unread INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, task_id TEXT, role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'done',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS messages_agent ON messages(agent_id, created_at);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, title TEXT NOT NULL, instructions TEXT NOT NULL,
  status TEXT NOT NULL, session_file TEXT, result TEXT, error TEXT,
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, task_id TEXT, kind TEXT NOT NULL, tool_name TEXT,
  payload TEXT NOT NULL, status TEXT NOT NULL, answer TEXT, resolved_by TEXT,
  created_at INTEGER NOT NULL, resolved_at INTEGER);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  stored_path TEXT NOT NULL, workspace_path TEXT, direction TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT, token_hash TEXT, status TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_seen_at INTEGER, last_ip TEXT, revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS pair_codes (
  code_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY, device_id TEXT, sub TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS usage (
  agent_id TEXT NOT NULL, day TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
  input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, day, provider, model));
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', session_file TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS conversations_agent ON conversations(agent_id, updated_at);
CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY, bank TEXT NOT NULL, text TEXT NOT NULL, kind TEXT, document_id TEXT,
  created_at TEXT NOT NULL, occurred_at TEXT, source_json TEXT, meta_json TEXT, embedding BLOB);
CREATE INDEX IF NOT EXISTS memory_items_bank ON memory_items(bank, created_at);
CREATE TABLE IF NOT EXISTS memory_banks (bank TEXT PRIMARY KEY, profile_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(text, id UNINDEXED, bank UNINDEXED, tokenize = 'trigram');
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, conversation_id TEXT, name TEXT NOT NULL, prompt TEXT NOT NULL,
  trigger TEXT NOT NULL, cron TEXT, tz TEXT NOT NULL DEFAULT 'Asia/Shanghai', quiet TEXT, webhook_secret TEXT,
  status TEXT NOT NULL DEFAULT 'active', next_run_at INTEGER, last_run_at INTEGER, created_by TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS routine_runs (
  id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, trigger TEXT NOT NULL, status TEXT NOT NULL, task_id TEXT,
  payload TEXT, result TEXT, error TEXT, started_at INTEGER NOT NULL, finished_at INTEGER);
CREATE INDEX IF NOT EXISTS routine_runs_r ON routine_runs(routine_id, started_at);
`);

export function getSetting<T>(key: string, fallback: T): T {
	const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
	return row ? (JSON.parse(row.value) as T) : fallback;
}
export function setSetting(key: string, value: unknown) {
	db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
}

export const now = () => Date.now();
export const uid = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// ---------------------------------------------------------------- 轻量迁移：给旧库补列
for (const [table, col, ddl] of [
	["agents", "description", "TEXT NOT NULL DEFAULT ''"],
	["pair_codes", "pre_approved", "INTEGER NOT NULL DEFAULT 0"],
	["agents", "conversation_id", "TEXT"],
	["agents", "memory_provider", "TEXT"],
	["messages", "conversation_id", "TEXT"],
	["tasks", "conversation_id", "TEXT"],
	["tasks", "routine_run_id", "TEXT"],
	["requests", "conversation_id", "TEXT"],
] as const) {
	const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
	if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
db.exec("CREATE INDEX IF NOT EXISTS messages_conv ON messages(conversation_id, created_at)");

// 旧库：每个助理把已有消息归到一个“默认对话”（沿用原来的 Pi 会话文件）
for (const a of db.prepare("SELECT id, session_file, created_at FROM agents WHERE conversation_id IS NULL").all() as { id: string; session_file: string | null; created_at: number }[]) {
	const id = uid("c");
	const last = (db.prepare("SELECT MAX(created_at) AS t FROM messages WHERE agent_id = ?").get(a.id) as { t: number | null }).t ?? a.created_at;
	db.prepare("INSERT INTO conversations(id, agent_id, title, session_file, created_at, updated_at) VALUES(?,?,?,?,?,?)").run(id, a.id, "", a.session_file, a.created_at, last);
	db.prepare("UPDATE agents SET conversation_id = ? WHERE id = ?").run(id, a.id);
	db.prepare("UPDATE messages SET conversation_id = ? WHERE agent_id = ? AND conversation_id IS NULL").run(id, a.id);
	db.prepare("UPDATE tasks SET conversation_id = ? WHERE agent_id = ? AND conversation_id IS NULL").run(id, a.id);
}
