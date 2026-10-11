// 极简 OpenAI 兼容接口（模拟“中转站”），用于测试自定义模型服务：
//   GET  /v1/models            → 模型列表（需要 Bearer key）
//   POST /v1/chat/completions  → 流式 / 非流式回复
import { createServer } from "node:http";

export function startMockOpenAI({ port = 0, key = "sk-relay-test", requiredHeader = null } = {}) {
	const seen = [];
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const c of req) body += c;
		seen.push({ method: req.method, url: req.url, headers: req.headers, body });
		const deny = (code, msg) => (res.writeHead(code, { "content-type": "application/json" }), res.end(JSON.stringify({ error: { message: msg } })));
		if (req.headers.authorization !== `Bearer ${key}`) return deny(401, "invalid api key");
		if (requiredHeader && req.headers[requiredHeader[0]] !== requiredHeader[1]) return deny(403, `missing header ${requiredHeader[0]}`);
		if (req.method === "GET" && req.url === "/v1/models") {
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(JSON.stringify({ object: "list", data: [{ id: "relay-chat", object: "model" }, { id: "relay-pro", object: "model" }] }));
		}
		if (req.method === "POST" && req.url === "/v1/chat/completions") {
			const j = JSON.parse(body || "{}");
			const last = [...(j.messages ?? [])].reverse().find((m) => m.role === "user");
			const userText = typeof last?.content === "string" ? last.content : (last?.content ?? []).map((p) => p.text ?? "").join("");
			const text = `中转站回复（${j.model}）：收到「${userText.slice(0, 40)}」`;
			if (!j.stream) {
				res.writeHead(200, { "content-type": "application/json" });
				return res.end(JSON.stringify({ id: "c1", object: "chat.completion", model: j.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
			}
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: j.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			res.write(chunk({ role: "assistant", content: "" }));
			for (const ch of text.match(/.{1,4}/gu) ?? []) {
				res.write(chunk({ content: ch }));
				await new Promise((r) => setTimeout(r, 15));
			}
			res.write(chunk({}, "stop"));
			res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: j.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`);
			res.end("data: [DONE]\n\n");
			return;
		}
		deny(404, "not found");
	});
	// 默认随机端口（固定端口被上次没退干净的进程占着时，listen 失败会让测试一直挂住）
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			const p = server.address().port;
			resolve({ server, seen, url: `http://127.0.0.1:${p}/v1`, close: () => (server.closeAllConnections?.(), server.close()) });
		});
	});
}

if (import.meta.url === `file://${process.argv[1]}`) startMockOpenAI().then((m) => console.log("mock openai at", m.url));
