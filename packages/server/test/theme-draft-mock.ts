/**
 * 主题设计单测用的假模型服务（OpenAI 兼容，流式，和 e2e/mock-openai.mjs 同协议）。
 *
 * 它不是 stub：Pi 走真实 pi-adapter → 真实 AgentSession → 真实 HTTP 请求到本服务。
 * 每一步可以返回一段文字，或一个 theme_draft 工具调用（用来验证结构化产出链路）。
 */
import { createServer } from "node:http";

export interface MockStep {
	text?: string;
	toolCall?: { name: string; args: unknown };
	/** 延迟多少毫秒再响应（测超时 / 取消）。 */
	delayMs?: number;
}

export interface ThemeDraftMock {
	url: string;
	/** 收到的原始请求体（按顺序）。 */
	seen: any[];
	close(): void;
}

export function startThemeDraftMock(steps: MockStep[]): Promise<ThemeDraftMock> {
	const seen: any[] = [];
	let step = 0;
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const c of req) body += c;
		if (req.method === "GET" && req.url === "/v1/models") {
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(JSON.stringify({ object: "list", data: [{ id: "theme-mock", object: "model" }] }));
		}
		if (req.method === "POST" && req.url === "/v1/chat/completions") {
			const j = JSON.parse(body || "{}");
			seen.push(j);
			const s = steps[Math.min(step, steps.length - 1)] ?? { text: "好的" };
			step += 1;
			if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
			if (res.writableEnded || res.destroyed) return;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const chunk = (delta: unknown, finish: string | null = null) =>
				`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: j.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			res.write(chunk({ role: "assistant", content: "" }));
			if (s.toolCall) {
				res.write(chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: s.toolCall.name, arguments: JSON.stringify(s.toolCall.args) } }] }));
				res.write(chunk({}, "tool_calls"));
			} else {
				for (const ch of (s.text ?? "好的").match(/[\s\S]{1,6}/gu) ?? []) res.write(chunk({ content: ch }));
				res.write(chunk({}, "stop"));
			}
			res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: j.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
			res.end("data: [DONE]\n\n");
			return;
		}
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "not found" } }));
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			resolve({ url: `http://127.0.0.1:${port}/v1`, seen, close: () => (server.closeAllConnections?.(), server.close()) });
		});
	});
}
