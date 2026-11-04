/** 快速执行（决策模型）设置：设置 › 操作这台电脑 里的那一块。写法照 routes/host-control.ts。 */
import { Hono } from "hono";
import { availableClassifiers, fastExecutorFor, fastExecutorSettings, saveFastExecutorSettings, type FastExecutorSettings } from "../fast-executor.ts";
import { localOnly, type Env } from "./common.ts";

export function mountFastExecutorRoutes(app: Hono<Env>) {
	/** 设置 + 可选的决策模型 + 现在实际用的是哪个（界面一行小字显示） */
	const state = () => ({ settings: fastExecutorSettings(), models: availableClassifiers(), effective: fastExecutorFor() });
	app.get("/api/fast-executor", (c) => c.json(state()));
	app.put("/api/fast-executor", localOnly, async (c) => {
		try {
			saveFastExecutorSettings(await c.req.json<Partial<FastExecutorSettings>>());
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
		return c.json(state());
	});
}
