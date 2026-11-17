/** 单聊 / 群聊共用的上传路由；所属对象校验由挂载方提供。 */
import type { Hono } from "hono";
import type { UploadOwner } from "../files.ts";
import { abandonUpload, appendUpload, beginUpload, UploadError } from "../uploads.ts";
import type { Env } from "./common.ts";

export function mountUploadRoutes(app: Hono<Env>, path: string, ownerOf: (id: string) => UploadOwner | null, param: string) {
	app.post(path, async (c) => {
		const owner = ownerOf(c.req.param(param)!);
		if (!owner) return c.json({ error: "找不到要上传到的对话" }, 404);
		try {
			const body = await c.req.json<{ name?: unknown; size?: unknown }>();
			return c.json(beginUpload(owner, body.name, body.size));
		} catch (e) {
			return c.json({ error: e instanceof UploadError ? e.message : "上传信息不正确，请重新选择文件" }, e instanceof UploadError ? e.status : 400);
		}
	});
	app.put(`${path}/:uploadId`, async (c) => {
		const owner = ownerOf(c.req.param(param)!);
		if (!owner) return c.json({ error: "找不到要上传到的对话" }, 404);
		try {
			const offset = c.req.query("offset");
			const index = c.req.query("index");
			return c.json(await appendUpload(owner, c.req.param("uploadId")!, offset === undefined ? NaN : Number(offset), index === undefined ? NaN : Number(index), c.req.raw.body));
		} catch (e) {
			return c.json({ error: e instanceof UploadError ? e.message : "文件上传失败，请重新上传" }, e instanceof UploadError ? e.status : 400);
		}
	});
	app.delete(`${path}/:uploadId`, (c) => {
		const owner = ownerOf(c.req.param(param)!);
		if (!owner) return c.json({ error: "找不到要上传到的对话" }, 404);
		abandonUpload(owner, c.req.param("uploadId")!);
		return c.json({ ok: true });
	});
}
