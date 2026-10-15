// 假的 Hindsight HTTP 服务（测试用）：按 documentId 存文档，recall 做汉字匹配，reflect 拼一段回答。
// 只实现我们用到的接口；鉴权与真 Hindsight 的 API Key 租户扩展一致（Bearer）。
// 支持 tags / tags_match / tag_groups 源端过滤，并记录最近一次 reflect 的请求与命中，
// 供测试断言「源端隔离」：请求在发送时就用 provenance tag 限定了范围，而不是先喂全库再删输出。
import { createServer } from "node:http";

/** Hindsight tags_match 语义（与官方文档一致） */
const tagLeaf = (docTags, leaf) => {
	const t = docTags ?? [];
	const tags = leaf.tags ?? [];
	const count = tags.filter((x) => t.includes(x)).length;
	switch (leaf.match ?? "any") {
		case "all_strict":
			return tags.length > 0 && count === tags.length;
		case "all":
			return t.length === 0 || (tags.length > 0 && count === tags.length);
		case "any_strict":
			return count > 0;
		case "exact":
			return t.length === tags.length && count === tags.length;
		case "any":
		default:
			return t.length === 0 || count > 0;
	}
};
const tagGroup = (docTags, g) => {
	if (g == null) return true;
	if (Array.isArray(g.and)) return g.and.every((c) => tagGroup(docTags, c));
	if (Array.isArray(g.or)) return g.or.some((c) => tagGroup(docTags, c));
	if (g.not) return !tagGroup(docTags, g.not);
	return tagLeaf(docTags, g);
};

export function fakeHindsight(key, port = 0) {
	const banks = new Map();
	const docTags = new Map(); // bank -> Map(documentId -> tags)
	const calls = [];
	const reflects = [];
	let lastReflect = null;
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
		if (!rest && req.method === "DELETE") return (banks.delete(bank), docTags.delete(bank), json(200, { success: true }));
		if (!rest) return (banks.set(bank, banks.get(bank) ?? new Map()), json(200, { bank_id: bank }));
		const docs = banks.get(bank) ?? new Map();
		banks.set(bank, docs);
		if (!docTags.has(bank)) docTags.set(bank, new Map());
		const dtags = docTags.get(bank);
		const match = (q) => [...docs].filter(([, t]) => [...q].some((ch) => /\p{Script=Han}/u.test(ch) && t.includes(ch)));
		const scoped = (rows, b) => {
			if (Array.isArray(b.tag_groups) && b.tag_groups.length) return rows.filter(([id]) => b.tag_groups.every((g) => tagGroup(dtags.get(id) ?? [], g)));
			if (b.tags === undefined || b.tags === null) return rows;
			return rows.filter(([id]) => tagLeaf(dtags.get(id) ?? [], { tags: b.tags, match: b.tags_match ?? "any" }));
		};
		if (rest === "/memories" && req.method === "POST") {
			const b = JSON.parse(body);
			for (const it of b.items) {
				docs.set(it.document_id, it.content);
				dtags.set(it.document_id, it.tags ?? []);
			}
			return json(200, { success: true, bank_id: bank, items_count: b.items.length, async: !!b.async });
		}
		if (rest === "/memories/recall") {
			const rb = JSON.parse(body);
			const hits = scoped(match(rb.query), rb);
			return json(200, { results: hits.map(([id, t], i) => ({ id: `u${i}`, text: `【抽取】${t}`, type: "world", document_id: id })) });
		}
		if (rest === "/reflect") {
			const rb = JSON.parse(body);
			const hits = scoped(match(rb.query), rb);
			lastReflect = { bank, body: rb, hits: hits.map(([id, t]) => ({ document_id: id, text: t })) };
			reflects.push(lastReflect);
			return json(200, { text: hits.length ? `根据记忆：${hits.map(([, t]) => t).join("；")}` : "记忆里没有相关信息。", based_on: { memories: hits.map(([id, t], i) => ({ id: `u${i}`, text: t, type: "world", document_id: id })) } });
		}
		if (rest.startsWith("/documents/") && req.method === "DELETE") return (docs.delete(decodeURIComponent(rest.slice(11))), dtags.delete(decodeURIComponent(rest.slice(11))), json(200, { success: true }));
		if (rest === "/mental-models" && req.method === "POST") return json(200, { id: "x" });
		if (rest === "/mental-models") return json(200, { items: [{ id: "user-preferences", name: "用户偏好与习惯", content: "用户偏好简洁" }] });
		return json(404, {});
	});
	return {
		banks,
		calls,
		docTags,
		reflects,
		get lastReflect() {
			return lastReflect;
		},
		start: () => new Promise((ok) => srv.listen(port, "127.0.0.1", () => ok(srv.address().port))),
		stop: () => new Promise((ok) => (srv.closeAllConnections(), srv.close(() => ok()))),
	};
}
