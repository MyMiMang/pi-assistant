// 假的 Hindsight HTTP 服务（测试用）：按 documentId 存文档，recall 做汉字匹配，reflect 拼一段回答。
// 只实现我们用到的接口；鉴权与真 Hindsight 的 API Key 租户扩展一致（Bearer）。
import { createServer } from "node:http";

export function fakeHindsight(key, port = 0) {
	const banks = new Map();
	const calls = [];
	const srv = createServer(async (req, res) => {
		let body = "";
		for await (const c of req) body += c;
		const url = req.url ?? "";
		const json = (s, o) => (res.writeHead(s, { "content-type": "application/json" }), res.end(JSON.stringify(o)));
		if (url === "/health") return json(200, { status: "healthy" });
		if (req.headers.authorization !== `Bearer ${key}`) return json(401, { detail: "Invalid API key" });
		calls.push(`${req.method} ${url.split("?")[0]}`);
		const m = url.match(/^\/v1\/default\/banks(?:\/([^/?]+))?(\/[^?]*)?/);
		if (!m) return json(404, {});
		const [, bank, rest = ""] = m;
		if (!bank) return json(200, { banks: [...banks.keys()].map((b) => ({ bank_id: b })) });
		if (!rest && req.method === "DELETE") return (banks.delete(bank), json(200, { success: true }));
		if (!rest) return (banks.set(bank, banks.get(bank) ?? new Map()), json(200, { bank_id: bank }));
		const docs = banks.get(bank) ?? new Map();
		banks.set(bank, docs);
		const match = (q) => [...docs].filter(([, t]) => [...q].some((ch) => /\p{Script=Han}/u.test(ch) && t.includes(ch)));
		if (rest === "/memories" && req.method === "POST") {
			const b = JSON.parse(body);
			for (const it of b.items) docs.set(it.document_id, it.content);
			return json(200, { success: true, bank_id: bank, items_count: b.items.length, async: !!b.async });
		}
		if (rest === "/memories/recall") return json(200, { results: match(JSON.parse(body).query).map(([id, t], i) => ({ id: `u${i}`, text: `【抽取】${t}`, type: "world", document_id: id })) });
		if (rest === "/reflect") {
			const hits = match(JSON.parse(body).query);
			return json(200, { text: hits.length ? `根据记忆：${hits.map(([, t]) => t).join("；")}` : "记忆里没有相关信息。", based_on: { memories: hits.map(([id, t], i) => ({ id: `u${i}`, text: t, type: "world", document_id: id })) } });
		}
		if (rest.startsWith("/documents/") && req.method === "DELETE") return (docs.delete(decodeURIComponent(rest.slice(11))), json(200, { success: true }));
		if (rest === "/mental-models" && req.method === "POST") return json(200, { id: "x" });
		if (rest === "/mental-models") return json(200, { items: [{ id: "user-preferences", name: "用户偏好与习惯", content: "用户偏好简洁" }] });
		return json(404, {});
	});
	return {
		banks,
		calls,
		start: () => new Promise((ok) => srv.listen(port, "127.0.0.1", () => ok(srv.address().port))),
		stop: () => new Promise((ok) => (srv.closeAllConnections(), srv.close(() => ok()))),
	};
}
