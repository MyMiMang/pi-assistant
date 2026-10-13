/** 「复制到我的助理」：把群专属助理深拷贝成一个独立的普通助理（之后互不影响） */
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { bus } from "../bus.ts";
import { config } from "../config.ts";
import { db, now } from "../db.ts";
import { insertMessage } from "../messages.ts";
import { memory } from "../memory/index.ts";
import { hostSettings, saveHostSettings } from "../host-control.ts";
import { getAgent, listAgents } from "../runtime.ts";

export async function copyAgentToUser(srcId: string, opts: { name?: string; memory?: boolean } = {}) {
	const a = getAgent(srcId) as (ReturnType<typeof getAgent> & { proactivity?: string | null; proactive_cfg?: string | null }) | undefined;
	if (!a) throw new Error("助理不存在");
	const id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
	const taken = new Set(listAgents().map((x) => x.name));
	let name = (opts.name ?? "").trim().slice(0, 40) || a.name;
	for (let i = 2; taken.has(name) && i < 50; i++) name = `${a.name} ${i}`;
	db.prepare(
		"INSERT INTO agents(id, name, avatar, color, persona, description, model_provider, model_id, thinking, proactivity, proactive_cfg, memory_provider, sort, created_at, scope, room_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'user', NULL)",
	).run(id, name, a.avatar, a.color, a.persona, a.description, a.model_provider, a.model_id, a.thinking, a.proactivity ?? null, a.proactive_cfg ?? null, a.memory_provider, listAgents().length, now());
	// 头像图片
	const av = join(config.dataDir, "avatars", srcId);
	if (a.avatar.startsWith("img:") && existsSync(av)) cpSync(av, join(config.dataDir, "avatars", id), { recursive: true });
	// MCP 服务 / Pi 扩展包：只给部分助理开的，把新助理也加进去
	for (const t of ["mcp_servers", "pi_packages"]) {
		for (const r of db.prepare(`SELECT id, agents FROM ${t} WHERE agents IS NOT NULL`).all() as { id: string; agents: string }[]) {
			const list = JSON.parse(r.agents) as string[];
			if (list.includes(srcId) && !list.includes(id)) db.prepare(`UPDATE ${t} SET agents = ? WHERE id = ?`).run(JSON.stringify([...list, id]), r.id);
		}
	}
	// 本机操作档位
	const hs = hostSettings();
	if (hs.tiers[srcId]) saveHostSettings({ tiers: { ...hs.tiers, [id]: hs.tiers[srcId] === "full" ? "bounded" : hs.tiers[srcId] } });
	let copied = 0;
	if (opts.memory) {
		const data = await memory.exportAgent(srcId);
		// 共享的“用户”记忆本来就是大家共用的，只复制助理自己的那一份
		copied = data.agent?.items?.length ? await memory.importAgent(id, { agent: data.agent }) : 0;
	}
	insertMessage({ agentId: id, role: "assistant", content: `你好，我是${name} 👋 我是从群聊里复制过来的，人设、模型和设置都和原来一样${opts.memory ? `，还带上了 ${copied} 条记忆` : ""}。` });
	bus.emit({ type: "agents.changed" });
	bus.emit({ type: "mcp.changed" });
	return { id, memories: copied };
}
