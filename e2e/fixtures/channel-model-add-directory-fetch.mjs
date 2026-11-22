// Child-process preload only. Keep the canonical URL in product config; rewrite only at transport time.
import assert from "node:assert/strict";

const upstream = "https://ai-gateway.vercel.sh/v1";
const targets = new Map([
	[`GET ${upstream}/models`, process.env.PIA_E2E_DIRECTORY_URL],
	[`POST ${upstream}/chat/completions`, process.env.PIA_E2E_CHAT_URL],
]);
for (const target of targets.values()) assert.match(target, /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/v1\/(models|chat\/completions)$/);
const original = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
	const req = new Request(input, init);
	const target = targets.get(`${req.method} ${req.url}`);
	if (!target) throw new Error(`Blocked non-fixture fetch: ${req.method} ${req.url}`);
	return original(target, {
		method: req.method, headers: req.headers, body: req.body,
		duplex: "half", signal: req.signal, redirect: "error",
	});
};
