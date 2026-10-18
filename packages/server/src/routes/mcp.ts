/** 从 http.ts 拆出的路由（行为不变）。 */
import { Hono } from "hono";
import { bus } from "../bus.ts";
import { config } from "../config.ts";
import { ensureMcpPackage, syncMcpDownloads } from "../mcp-install.ts";
import { agentsOf, configOf, deleteMcp, getMcp, listMcp, type McpServerRow, redact, saveMcp, setMcpEnabled, testMcp } from "../mcp.ts";
import { addPackage, install as installPackage, listPackages, type PiPackageRow, removePackage, setPackageEnabled } from "../pi-packages.ts";
import { errJson, localOnly, type Env } from "./common.ts";

// ---------------------------------------------------------------- MCP 服务器与 Pi 扩展包
// 写操作只允许在这台电脑上做（stdio MCP 会在电脑上运行命令，扩展包会运行代码）
const mcpJson = (r: McpServerRow) => ({ id: r.id, name: r.name, enabled: !!r.enabled, agents: agentsOf(r), config: redact(configOf(r)), status: r.status, tools: r.tools ? JSON.parse(r.tools) : null, error: r.error, checkedAt: r.checked_at });

const pkgJson = (p: PiPackageRow) => ({ ...p, enabled: !!p.enabled, agents: p.agents ? JSON.parse(p.agents) : null, resources: p.resources ? JSON.parse(p.resources) : null });

export function mountMcpRoutes(app: Hono<Env>) {
	app.get("/api/mcp", (c) => c.json(listMcp().map(mcpJson)));
	app.post("/api/mcp", localOnly, async (c) => {
		try {
			const r = saveMcp(await c.req.json());
			void ensureMcpPackage(r.id).then(() => testMcp(r.id)).then(() => bus.emit({ type: "mcp.changed" } as never));
			return c.json(mcpJson(r));
		} catch (e) {
			return errJson(c, e);
		}
	});
	app.put("/api/mcp/:id", localOnly, async (c) => {
		try {
			const r = saveMcp({ ...(await c.req.json()), id: (c.req.param("id") as string) });
			void ensureMcpPackage(r.id).then(() => testMcp(r.id)).then(() => bus.emit({ type: "mcp.changed" } as never));
			return c.json(mcpJson(r));
		} catch (e) {
			return errJson(c, e);
		}
	});
	app.patch("/api/mcp/:id", localOnly, async (c) => {
		const b = await c.req.json<{ enabled: boolean; agents?: string[] | null }>();
		if (!getMcp((c.req.param("id") as string))) return c.json({ error: "not_found" }, 404);
		setMcpEnabled((c.req.param("id") as string), b.enabled, b.agents);
		return c.json(mcpJson(getMcp((c.req.param("id") as string))!));
	});
	app.post("/api/mcp/:id/test", localOnly, async (c) => {
		try {
			const r = await testMcp((c.req.param("id") as string));
			return c.json({ ...r, server: mcpJson(getMcp((c.req.param("id") as string))!) });
		} catch (e) {
			return errJson(c, e);
		}
	});
	app.delete("/api/mcp/:id", localOnly, (c) => {
		const ok = deleteMcp(c.req.param("id") as string);
		syncMcpDownloads();
		return c.json({ ok });
	});
	app.get("/api/pi-packages", (c) => c.json(listPackages().map(pkgJson)));
	app.post("/api/pi-packages", localOnly, async (c) => {
		const b = await c.req.json<{ source: string; agents?: string[] | null }>();
		try {
			return c.json(pkgJson(await addPackage(b.source, b.agents ?? null)));
		} catch (e) {
			return errJson(c, e);
		}
	});
	app.post("/api/pi-packages/:id/reinstall", localOnly, async (c) => (void installPackage((c.req.param("id") as string)), c.json({ ok: true })));
	app.patch("/api/pi-packages/:id", localOnly, async (c) => {
		const b = await c.req.json<{ enabled: boolean; agents?: string[] | null }>();
		setPackageEnabled((c.req.param("id") as string), b.enabled, b.agents);
		return c.json({ ok: true });
	});
	app.delete("/api/pi-packages/:id", localOnly, async (c) => c.json({ ok: await removePackage((c.req.param("id") as string)) }));
}
