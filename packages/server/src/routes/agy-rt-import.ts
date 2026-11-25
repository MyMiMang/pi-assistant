import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AgyRtError, createAgyRtImport, type AgyRtBackend } from "../cli-agents/agy-rt-import.ts";
import type { Env } from "./common.ts";
import type { createAgyAccountVault } from "../cli-agents/agy-account-vault.ts";

export function mountAgyRtImport(app: Hono<Env>, backend?: AgyRtBackend, accountVault?: ReturnType<typeof createAgyAccountVault>) {
	const apply = accountVault ?? (backend && createAgyRtImport(backend));
	const path = "/api/agy-rt-import";
	const guard = async (c: import("hono").Context<Env>, next: import("hono").Next) => {
		c.header("Cache-Control", "no-store");
		if (!c.get("caller").local) return c.json({ error: "local_only" }, 403);
		await next();
	};
	app.get(path, guard, async c => {
		if (!apply) return c.json({ available: false, current: null, accounts: [] });
		try { return c.json(await apply.status(AbortSignal.timeout(10_000))); }
		catch { return c.json({ error: "cli_unverified" }, 502); }
	});
	const ops = ["add", "switch", "switch-google", "remove"] as const;
	for (const op of ops) app.post(op === "add" ? path : `${path}/${op}`, guard, bodyLimit({ maxSize: 8192 }), async c => {
		if (!apply) return c.json({ error: "import_unavailable" }, 503);
		if (c.req.header("origin") !== new URL(c.req.url).origin || !/^application\/json(?:;|$)/i.test(c.req.header("content-type") ?? "")) return c.json({ error: "invalid_input" }, 403);
		if (op === "switch-google" && !accountVault) return c.json({ error: "import_unavailable" }, 503);
		const controller = new AbortController();
		const socket = c.env.incoming.socket;
		const close = () => controller.abort();
		socket.once("close", close);
		try {
			const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]);
			const payload = await c.req.json().catch(() => null);
			if (accountVault) return c.json(await accountVault.mutate(op, payload, signal));
			return c.json(await (apply as ReturnType<typeof createAgyRtImport>).mutate(op as "add" | "switch" | "remove", payload, signal));
		} catch (err) {
			const code = err instanceof AgyRtError ? err.code : "import_failed";
			const status = code === "occupied" ? 409 : code === "import_unavailable" ? 503 : code === "import_failed" ? 502 : 400;
			return c.json({ error: code }, status);
		} finally { socket.off("close", close); }
	});
}
