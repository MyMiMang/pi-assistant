// 模拟图片生成服务（单测 + e2e）：一个端口同时扮演
//   OpenAI 兼容  /v1/models、/v1/images/generations、/v1/images/edits（Bearer）
//   火山方舟      /api/v3/images/generations（Bearer）
//   阿里云百炼    /api/v1/services/aigc/text2image/image-synthesis（异步）+ /api/v1/tasks/:id、multimodal-generation、/compatible-mode/v1/models
//   Gemini       /v1beta/models、:generateContent、:predict（x-goog-api-key）
// prompt 里带「违规」→ 返回各家的安全策略错误；「慢」→ 迟迟不返回（测超时）
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
const crc = (b) => {
	let c = 0xffffffff;
	for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const td = Buffer.concat([Buffer.from(type), data]);
	const c = Buffer.alloc(4);
	c.writeUInt32BE(crc(td));
	return Buffer.concat([len, td, c]);
};
/** 生成一张 w×h 的渐变 PNG（颜色由 seed 决定） */
export function makePng(w = 96, h = 96, seed = 0) {
	const raw = Buffer.alloc((w * 3 + 1) * h);
	for (let y = 0; y < h; y++) {
		raw[y * (w * 3 + 1)] = 0;
		for (let x = 0; x < w; x++) {
			const o = y * (w * 3 + 1) + 1 + x * 3;
			raw[o] = (x * 255) / w + seed * 40;
			raw[o + 1] = (y * 255) / h;
			raw[o + 2] = 160 + seed * 30;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export function startMockImages({ port = 0, key = "sk-img-test" } = {}) {
	const seen = [];
	const tasks = new Map();
	let base = "";
	const server = createServer(async (req, res) => {
		const bufs = [];
		for await (const c of req) bufs.push(c);
		const raw = Buffer.concat(bufs);
		const body = raw.toString("utf8");
		const url = new URL(req.url, "http://x");
		const path = url.pathname;
		const j = (() => {
			try {
				return JSON.parse(body);
			} catch {
				return {};
			}
		})();
		seen.push({ method: req.method, path, headers: req.headers, body: req.headers["content-type"]?.startsWith("multipart") ? body.slice(0, 4000) : body, json: j });
		const send = (code, obj) => (res.writeHead(code, { "content-type": "application/json" }), res.end(JSON.stringify(obj)));
		if (path.startsWith("/files/")) return res.writeHead(200, { "content-type": "image/png" }), res.end(makePng(96, 96, Number(path.match(/(\d)/)?.[1] ?? 0)));
		const isGemini = path.startsWith("/v1beta/");
		const authed = isGemini ? req.headers["x-goog-api-key"] === key : req.headers.authorization === `Bearer ${key}`;
		if (!authed) return isGemini ? send(400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }) : send(401, { error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } });
		const prompt = String(j.prompt ?? j.input?.prompt ?? "") + (body.match(/name="prompt"\r\n\r\n([^\r]*)/)?.[1] ?? "");
		const slow = /慢/.test(prompt) || /慢/.test(body);
		if (slow) await new Promise((r) => setTimeout(r, 3000));
		const b64 = (i = 0) => makePng(96, 96, i).toString("base64");
		// ---- OpenAI 兼容 / 方舟
		if (req.method === "GET" && (path === "/v1/models" || path === "/compatible-mode/v1/models")) return send(200, { object: "list", data: ["relay-chat", "gpt-image-1", "flux-dev", "text-embedding-3-small", "qwen-image", "wanx2.1-t2i-turbo"].map((id) => ({ id, object: "model" })) });
		if (req.method === "POST" && /\/images\/generations$/.test(path)) {
			if (/违规/.test(prompt)) return path.startsWith("/api/v3") ? send(400, { error: { code: "InputTextSensitiveContentDetected", message: "The request failed because the input text may contain sensitive information." } }) : send(400, { error: { message: "Your request was rejected by the safety system.", type: "image_generation_user_error", code: "moderation_blocked" } });
			if (j.model === "strict-size" && j.size) return send(400, { error: { message: "Unknown parameter: 'size'.", type: "invalid_request_error" } });
			if (j.model === "nope") return send(404, { error: { message: "The model `nope` does not exist", code: "model_not_found" } });
			const n = j.n ?? 1;
			if (j.response_format === "url") return send(200, { data: Array.from({ length: n }, (_, i) => ({ url: `${base}/files/${i}.png` })) });
			return send(200, { created: 1, data: Array.from({ length: n }, (_, i) => ({ b64_json: b64(i), revised_prompt: j.model === "dall-e-3" ? `${prompt}（改写）` : undefined })) });
		}
		if (req.method === "POST" && path === "/v1/images/edits") {
			if (!/name="image(\[\])?"/.test(body)) return send(400, { error: { message: "image is required" } });
			return send(200, { data: [{ b64_json: b64(3) }] });
		}
		// ---- 百炼
		if (req.method === "POST" && path === "/api/v1/services/aigc/text2image/image-synthesis") {
			if (req.headers["x-dashscope-async"] !== "enable") return send(400, { code: "InvalidParameter", message: "current user api does not support synchronous calls" });
			if (/违规/.test(prompt)) return send(400, { code: "DataInspectionFailed", message: "Input data may contain inappropriate content." });
			const id = `task-${tasks.size + 1}`;
			tasks.set(id, { polls: 0, n: j.parameters?.n ?? 1 });
			return send(200, { output: { task_id: id, task_status: "PENDING" }, request_id: "r1" });
		}
		const tm = path.match(/^\/api\/v1\/tasks\/(.+)$/);
		if (req.method === "GET" && tm) {
			const t = tasks.get(tm[1]);
			if (!t) return send(404, { code: "NotFound", message: "task not found" });
			t.polls++;
			if (t.polls < 2) return send(200, { output: { task_id: tm[1], task_status: "RUNNING" } });
			return send(200, { output: { task_id: tm[1], task_status: "SUCCEEDED", results: Array.from({ length: t.n }, (_, i) => ({ url: `${base}/files/${i}.png`, actual_prompt: "扩写后的描述" })) } });
		}
		if (req.method === "POST" && path === "/api/v1/services/aigc/multimodal-generation/generation") {
			const content = j.input?.messages?.[0]?.content ?? [];
			if (!content.some((c) => c.image)) return send(400, { code: "InvalidParameter", message: "image required" });
			return send(200, { output: { choices: [{ message: { role: "assistant", content: [{ image: `${base}/files/2.png` }] } }] } });
		}
		// ---- Gemini
		if (req.method === "GET" && path === "/v1beta/models") return send(200, { models: ["gemini-2.5-flash", "gemini-2.5-flash-image", "imagen-4.0-generate-001", "text-embedding-004"].map((n) => ({ name: `models/${n}` })) });
		const gm = path.match(/^\/v1beta\/models\/([^:]+):(generateContent|predict)$/);
		if (req.method === "POST" && gm) {
			const text = gm[2] === "predict" ? (j.instances?.[0]?.prompt ?? "") : (j.contents?.[0]?.parts ?? []).map((p) => p.text ?? "").join("");
			if (/违规/.test(text)) return gm[2] === "predict" ? send(200, { predictions: [] }) : send(200, { candidates: [{ finishReason: "IMAGE_SAFETY", content: { parts: [] } }] });
			if (gm[2] === "predict") return send(200, { predictions: Array.from({ length: j.parameters?.sampleCount ?? 1 }, (_, i) => ({ bytesBase64Encoded: b64(i), mimeType: "image/png" })) });
			return send(200, { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "好的，这是你要的图。" }, { inlineData: { mimeType: "image/png", data: b64(1) } }] } }] });
		}
		send(404, { error: { message: `not found ${req.method} ${path}` } });
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			const p = server.address().port;
			base = `http://127.0.0.1:${p}`;
			resolve({ server, seen, base, url: `${base}/v1`, close: () => (server.closeAllConnections?.(), server.close()) });
		});
	});
}

if (import.meta.url === `file://${process.argv[1]}`) startMockImages({ port: Number(process.env.PORT ?? 0) }).then((m) => console.log("mock images at", m.base));
