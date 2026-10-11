/** Web Push（VAPID）。服务端直接发给浏览器厂商的推送服务，不需要我们托管推送服务器。 */
import webpush from "web-push";
import { db, getSetting, now, setSetting } from "./db.ts";

let ready = false;
function init() {
	if (ready) return;
	let keys = getSetting<{ publicKey: string; privateKey: string } | null>("vapid", null);
	if (!keys) {
		keys = webpush.generateVAPIDKeys();
		setSetting("vapid", keys);
	}
	webpush.setVapidDetails("mailto:noreply@huhao.local", keys.publicKey, keys.privateKey);
	ready = true;
}
export function vapidPublicKey() {
	init();
	return getSetting<{ publicKey: string }>("vapid", { publicKey: "" }).publicKey;
}
export function subscribe(sub: { endpoint: string }, deviceId: string | null) {
	db.prepare("INSERT INTO push_subs(endpoint, device_id, sub, created_at) VALUES(?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET sub = excluded.sub, device_id = excluded.device_id").run(
		sub.endpoint,
		deviceId,
		JSON.stringify(sub),
		now(),
	);
}
export const pushLog: { at: number; title: string; sent: number }[] = [];
export function notify(n: { title: string; body: string; tag?: string; url?: string; data?: Record<string, unknown> }) {
	init();
	const subs = db.prepare("SELECT endpoint, sub FROM push_subs").all() as { endpoint: string; sub: string }[];
	pushLog.push({ at: now(), title: n.title, sent: subs.length });
	if (pushLog.length > 50) pushLog.shift();
	const payload = JSON.stringify({ title: n.title, body: n.body.slice(0, 180), tag: n.tag, url: n.url, data: n.data });
	for (const s of subs) {
		webpush.sendNotification(JSON.parse(s.sub), payload, { TTL: 3600 }).catch((e: { statusCode?: number }) => {
			if (e.statusCode === 404 || e.statusCode === 410) db.prepare("DELETE FROM push_subs WHERE endpoint = ?").run(s.endpoint);
		});
	}
}
