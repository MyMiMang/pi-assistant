// 手机聊天历史分页 / 上滑加载 / 引用跳转的纯前端 fixture 测试。
//
// 静态托管 apps/web/dist，用 page.route 拦截所有 /api，用真实 WebSocket 推一条新消息，
// 不启动 packages/server/src/main.ts：不碰系统钥匙串、不读写用户真实数据、不调付费模型。
//
// 覆盖：
//   1. 首屏有界：只拉 limit=50（不是旧版 300），渲染条数随 limit 有界；
//   2. 单聊上滑加载更早：稳定复合游标 before/beforeSeq，插入上方后按高度差回填锚点；
//   3. 往上翻（stick=false）时新消息不把视图拉到底；
//   4. 引用跳未加载的旧消息：从当前窗口**连续**向更早分页，最终列表里没有分页空洞；
//   5. 群聊上滑加载更早（before=seq）。
//
// 切会话晚返回旧响应不覆盖新目标由 e2e/conversation-restore.mjs 覆盖，这里不重复。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const dist = join(root, 'apps/web/dist');
if (!existsSync(join(dist, 'index.html'))) {
	console.error('找不到 apps/web/dist/index.html；先跑 `npm run build -w @pi-assistant/web`');
	process.exit(2);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.map': 'application/json' };
const web = createServer(async (req, res) => {
	const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
	let file = join(dist, path);
	if (path === '/' || path === '') file = join(dist, 'index.html');
	try {
		const data = await readFile(file);
		res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
		res.end(data);
	} catch {
		const html = await readFile(join(dist, 'index.html'));
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end(html);
	}
});
// 真实 WebSocket：应用连 /ws 后可直接推 message.created（不依赖服务端 hello 也能处理事件）
const wss = new WebSocketServer({ noServer: true });
const wsClients = new Set();
wss.on('connection', (ws) => {
	wsClients.add(ws);
	ws.on('close', () => wsClients.delete(ws));
	ws.on('message', () => {});
});
web.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)));
const pushEvent = (e) => {
	const s = JSON.stringify(e);
	for (const ws of wsClients) if (ws.readyState === 1) ws.send(s);
};
const waitWs = async () => {
	for (let i = 0; i < 100 && wsClients.size === 0; i++) await new Promise((r) => setTimeout(r, 50));
};
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${web.address().port}`;
const SEL_KEY = 'pia.sel.srv1.dev1';

const system = {
	serverId: 'srv1', publicKey: 'pk', pi: { version: '0.0.0', testedWith: '0.0.0', compatible: true, message: 'ok' },
	mock: true, local: true, owner: true, server: false, deviceId: 'dev1', onboarded: true, modelSetupDone: true, modelReady: true,
	defaultModel: { provider: 'mock', id: 'mock' }, credentialBackend: 'file',
	sandbox: { mode: 'workspace', preference: 'workspace', dockerAvailable: false }, entryDomain: null,
	tunnel: { enabled: false, state: 'off', mode: 'quick', url: null, failures: 0, rendezvous: { state: 'off' }, binary: null, named: {} },
	workspaceRoot: '/tmp/ws', push: { publicKey: 'pk' }, seq: 1,
};
const agent = (id, name) => ({ id, name, avatar: name, color: '#888', persona: '', description: '', status: 'idle', unread: 0, model: null, workspace: '/tmp', scope: 'user' });

// 120 条单聊 + 80 条群聊，created_at / seq 单调递增
const N = 120;
const ROOMN = 80;
const msg = (id, agentId, convId, content, i, extra = {}) => ({ id, agent_id: agentId, conversation_id: convId, task_id: null, role: 'user', content, meta: {}, status: 'done', created_at: 1000 + i, updated_at: 1000 + i, seq: i, ...extra });
const ROOM_CAPS = { maxTurns: 6, maxDepth: 1, perAgent: 3, tokenBudget: 0, followup: true };
const ROOM_OBJ = { id: 'room1', name: '群一', purpose: '', managerId: 'a1', unread: 0, paused: null, caps: ROOM_CAPS, state: { running: false, current: null, queue: [] }, members: [{ agentId: 'a1', conversationId: 'c1', name: '甲', avatar: '甲', color: '#888', sort: 0 }] };

const AGENT_MSGS = Array.from({ length: N }, (_, k) => {
	const i = k + 1;
	if (i === N) {
		// 最后一条引用最早那条（未加载）：点引用要能连续分页跳过去且不留空洞
		return msg(`m${i}`, 'a1', 'c1', `第 ${i} 条`, i, {
			replyToId: 'm1',
			reply: { messageId: 'm1', author: { id: '', name: '我', role: 'user' }, source: { kind: 'conversation', id: 'c1' }, excerpt: '第 1 条', truncated: false, edited: false, createdAt: 1001 },
		});
	}
	return msg(`m${i}`, 'a1', 'c1', `第 ${i} 条`, i);
});
const ROOM_MSGS = Array.from({ length: ROOMN }, (_, k) => {
	const i = k + 1;
	return { ...msg(`r${i}`, 'a1', null, `群消息 ${i}`, i), room_id: 'room1' };
});

const pageAgentMessages = ({ limit, before, beforeSeq }) => {
	const all = AGENT_MSGS;
	const b = before !== undefined ? Number(before) : Number.MAX_SAFE_INTEGER;
	const bs = beforeSeq !== undefined ? Number(beforeSeq) : Number.MAX_SAFE_INTEGER;
	const filtered = all.filter((m) => m.created_at < b || (m.created_at === b && m.seq < bs));
	return filtered.slice(-limit);
};
const pageRoomMessages = ({ limit, before }) => {
	const all = ROOM_MSGS;
	const filtered = before !== undefined ? all.filter((m) => m.seq < Number(before)) : all;
	return filtered.slice(-limit);
};

function reset() {
	return { requests: {}, convs: { a1: { current: 'c1', items: [{ id: 'c1', agent_id: 'a1', title: '主对话', created_at: 1, updated_at: 2, message_count: N, last: { content: `第 ${N} 条`, role: 'user', created_at: 1000 + N } }] } } };
}
let S = reset();
const count = (k) => (S.requests[k] = (S.requests[k] ?? 0) + 1);
const reqs = (k) => S.requests[k] ?? 0;

async function makePage(browser, viewport) {
	const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
	await context.addInitScript(([k, v]) => localStorage.setItem(k, v), [SEL_KEY, JSON.stringify({ agentId: 'a1', convs: { a1: 'c1' } })]);
	const page = await context.newPage();
	page.on('dialog', (d) => void d.dismiss());
	await page.route('**/api/**', async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const path = url.pathname;
		const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
		if (path === '/api/system') return json(system);
		if (path === '/api/agents') return json([agent('a1', '甲')]);
		if (path === '/api/rooms') return json([ROOM_OBJ]);
		if (path === '/api/downloads') return json({ items: [] });
		if (path === '/api/models') return json([]);
		if (path === '/api/models/providers') return json([]);
		if (path === '/api/models/picks') return json({ picks: {} });
		if (path === '/api/sandbox-computer') return json({ approvals: 'sensitive' });
		if (path === '/api/host-control') return json({ status: { enabled: false, paused: false, platform: 'darwin' }, activity: { active: false, agent: null, summary: null }, settings: { agents: [], apps: [], workspaceFiles: [], defaultTier: 'bounded' }, tiers: {}, permissions: null, manifestHash: '' });
		if (/^\/api\/agents\/[^/]+\/proactive$/.test(path)) return json({ level: 'normal', levelSetting: null, effectiveLevel: 'normal', throttled: false, cfg: {}, cadenceMin: 30, budget: 0, usedToday: 0, nextHeartbeatAt: null, lastHeartbeatAt: null, followups: [] });
		if (/^\/api\/conversations\/[^/]+\/context$/.test(path)) return json({ tokens: null, contextWindow: null, percent: null, model: null, session: null });
		if (path.startsWith('/api/proactive/inbox')) return json({ items: [], count: 0, defaultLevel: 'normal' });
		let m = path.match(/^\/api\/agents\/([^/]+)\/conversations$/);
		if (m) return json(S.convs[m[1]] ?? { current: 'cx', items: [] });
		m = path.match(/^\/api\/agents\/([^/]+)\/conversations\/([^/]+)\/select$/);
		if (m) return json({ ok: true });
		m = path.match(/^\/api\/agents\/([^/]+)\/tasks$/);
		if (m) return json([]);
		m = path.match(/^\/api\/agents\/([^/]+)\/read$/);
		if (m) return json({ ok: true });
		m = path.match(/^\/api\/agents\/([^/]+)\/subagents$/);
		if (m) return json([]);
		m = path.match(/^\/api\/agents\/([^/]+)\/skills$/);
		if (m) return json({ skills: [] });
		m = path.match(/^\/api\/routines$/);
		if (m) return json([]);
		m = path.match(/^\/api\/messages\/([^/]+)\/context$/);
		if (m) {
			const mid = m[1];
			const target = AGENT_MSGS.find((x) => x.id === mid);
			if (!target) return json({ error: 'not_found' }, 404);
			return json(AGENT_MSGS.filter((x) => x.seq >= target.seq - 25 && x.seq <= target.seq + 25));
		}
		m = path.match(/^\/api\/agents\/([^/]+)\/messages$/);
		if (m) {
			const limit = Number(url.searchParams.get('limit') ?? 200);
			const before = url.searchParams.get('before');
			const beforeSeq = url.searchParams.get('beforeSeq');
			count('agentMessages');
			if (url.searchParams.get('conversation')) count('agentMessagesConv');
			return json(pageAgentMessages({ limit, ...(before !== null ? { before } : {}), ...(beforeSeq !== null ? { beforeSeq } : {}) }));
		}
		m = path.match(/^\/api\/rooms\/([^/]+)\/messages$/);
		if (m) {
			const limit = Number(url.searchParams.get('limit') ?? 200);
			const before = url.searchParams.get('before');
			count('roomMessages');
			return json(pageRoomMessages({ limit, ...(before !== null ? { before } : {}) }));
		}
		m = path.match(/^\/api\/rooms\/([^/]+)\/read$/);
		if (m) return json({ ok: true });
		return json({});
	});
	await page.goto(`${BASE}/?agent=a1`);
	return { page, context };
}

const idsInDom = (page) => page.$$eval('.pa-scroll [data-mid]', (els) => els.map((e) => e.getAttribute('data-mid')));
const scroller = (page) => page.locator('.pa-scroll');

let browser;
const results = [];
async function step(name, fn) {
	try {
		await fn();
		results.push(['✅', name]);
		console.log('✅', name);
	} catch (e) {
		results.push(['❌', name, String(e).slice(0, 800)]);
		console.log('❌', name, e);
	}
}

try {
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });

	await step('[手机390] 首屏有界：只拉 limit=50，不是旧版 300', async () => {
		S = reset();
		const { page, context } = await makePage(browser, { width: 390, height: 844 });
		await page.locator('.pa-scroll [data-mid]').first().waitFor({ timeout: 10000 });
		const ids = await idsInDom(page);
		assert.equal(ids.length, 50, `首屏应只渲染 50 条，实际 ${ids.length}`);
		assert.equal(ids[0], 'm71');
		assert.equal(ids.at(-1), 'm120');
		assert.equal(reqs('agentMessages'), 1, `首屏只应发一次历史请求，实际 ${reqs('agentMessages')}`);
		assert.ok(reqs('agentMessagesConv') >= 1);
		// 浏览器 HTTP 缓存 / SW 不在这里测（纯 fixture 无压缩），只测应用层有界。
		await context.close();
	});

	await step('[手机390] 上滑加载更早：稳定复合游标 before/beforeSeq + 插入后锚点回填不跳', async () => {
		S = reset();
		const { page, context } = await makePage(browser, { width: 390, height: 844 });
		const sc = scroller(page);
		await page.locator('.pa-scroll [data-mid]').first().waitFor();
		// 先把滚动条拉到顶（触发自动加载更早），同时记录锚点消息 m71 的位置
		await page.evaluate(() => {
			const el = document.querySelector('.pa-scroll');
			el.scrollTop = 0;
			el.dispatchEvent(new Event('scroll'));
		});
		await page.waitForFunction(() => document.querySelectorAll('.pa-scroll [data-mid]').length === 100, null, { timeout: 8000 });
		const ids = await idsInDom(page);
		assert.equal(ids[0], 'm21', `应无缝插到 m21，实际 ${ids[0]}（共 request=${reqs('agentMessages')}，ids=${ids.slice(0, 3).join(',')}..${ids.slice(-2).join(',')}，len=${ids.length}）`);
		assert.equal(reqs('agentMessages'), 2, `停在顶部只应自动加载一页（首次 + 一页）；实际 ${reqs('agentMessages')} 次说明在把整段历史一页页拉完`);
		assert.equal(ids.at(-1), 'm120');
		// 锚点：加载前在视口顶部的 m71 加载后仍应靠近视口顶部（回填 scrollTop，不跳到列表顶）
		const anchorTop = await page.evaluate(() => {
			const el = document.querySelector('.pa-scroll');
			const m71 = document.querySelector('.pa-scroll [data-mid="m71"]');
			return { scrollTop: el.scrollTop, m71Top: m71.getBoundingClientRect().top, containerTop: el.getBoundingClientRect().top };
		});
		assert.ok(anchorTop.scrollTop > 0, '插入上方后 scrollTop 应大于 0（否则会跳到最早）');
		assert.ok(Math.abs(anchorTop.m71Top - anchorTop.containerTop) < 260, `锚点应基本停在视口顶部，实际偏移 ${Math.round(anchorTop.m71Top - anchorTop.containerTop)}px`);
		// 继续上滑还能加载更早，直到 m1，全程连续。
		// 注意：这里是真实手势——先离开顶部（>=200px）再滑回顶部；停在顶部不会自动继续拉（见 Chat.tsx onScroll）。
		await page.evaluate(() => {
			const el = document.querySelector('.pa-scroll');
			el.scrollTop = 600;
			el.dispatchEvent(new Event('scroll'));
			el.scrollTop = 0;
			el.dispatchEvent(new Event('scroll'));
		});
		await page.waitForFunction((n) => document.querySelectorAll('.pa-scroll [data-mid]').length === n, N, { timeout: 8000 });
		const all = await idsInDom(page);
		assert.deepEqual(all, Array.from({ length: N }, (_, k) => `m${k + 1}`), '最终应连续覆盖 m1..m120，无缺口');
		await context.close();
	});

	await step('[手机390] 往上翻时新消息不拉底；贴底时新消息跟随到底', async () => {
		S = reset();
		const { page, context } = await makePage(browser, { width: 390, height: 844 });
		const sc = scroller(page);
		await page.locator('.pa-scroll [data-mid]').first().waitFor();
		// 应用连上 WS 后再推新消息，避免竞态
		await waitWs();
		// 往上翻（stick=false）
		await page.evaluate(() => {
			const el = document.querySelector('.pa-scroll');
			el.scrollTop = 0;
			el.dispatchEvent(new Event('scroll'));
		});
		const before = await sc.evaluate((el) => el.scrollTop);
		pushEvent({ type: 'message.created', message: { ...msg('m121', 'a1', 'c1', '新消息', 121), conversation_id: 'c1' } });
		await page.locator('.pa-scroll [data-mid="m121"]').waitFor({ timeout: 5000 });
		const after = await sc.evaluate((el) => el.scrollTop);
		assert.ok(Math.abs(after - before) < 40, `往上翻时新消息不应改变滚动位置：before=${before} after=${after}`);
		// 贴底（stick=true）→ 新消息把视图带到底
		await page.evaluate(() => {
			const el = document.querySelector('.pa-scroll');
			el.scrollTop = el.scrollHeight;
			el.dispatchEvent(new Event('scroll'));
		});
		pushEvent({ type: 'message.created', message: { ...msg('m122', 'a1', 'c1', '再来', 122), conversation_id: 'c1' } });
		await page.locator('.pa-scroll [data-mid="m122"]').waitFor({ timeout: 5000 });
		await page.waitForTimeout(100);
		const atBottom = await sc.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 120);
		assert.ok(atBottom, '贴底时新消息应跟随到底');
		await context.close();
	});

	await step('[手机390] 引用跳未加载的旧消息：连续分页加载，列表无分页空洞', async () => {
		S = reset();
		const { page, context } = await makePage(browser, { width: 390, height: 844 });
		await page.locator('.pa-scroll [data-mid]').first().waitFor();
		// 点最后一条消息里的引用块（引用最早的 m1，未加载）
		await page.locator('.pa-scroll [data-mid="m120"] [data-testid="quoted-block"]').click();
		// 目标最终应被加载并高亮；列表应连续覆盖 m1..m120
		await page.locator('.pa-scroll [data-mid="m1"]').first().waitFor({ timeout: 10000 });
		await page.waitForFunction(() => document.querySelectorAll('.pa-scroll [data-mid]').length === 120, null, { timeout: 8000 });
		const all = await idsInDom(page);
		assert.deepEqual(all, Array.from({ length: N }, (_, k) => `m${k + 1}`), '引用跳转后不得留下分页空洞');
		// 引用跳转应走「连续向更早分页」（多次带 before 的请求），而不是发一次 /context 后插一个孤立窗口
		const urls = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/messages')));
		assert.ok(reqs('agentMessages') >= 3, `引用跳应继续分页加载，实际历史请求 ${reqs('agentMessages')} 次`);
		void urls;
		await context.close();
	});

	await step('[桌面] 群聊上滑加载更早：before=seq，插入上方保锚点', async () => {
		S = reset();
		const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
		const page = await context.newPage();
		const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
		await page.route('**/api/**', async (route) => {
			const url = new URL(route.request().url());
			const path = url.pathname;
			if (path === '/api/system') return json(route, system);
			if (path === '/api/agents') return json(route, [agent('a1', '甲')]);
			if (path === '/api/rooms') return json(route, [ROOM_OBJ]);
			if (path === '/api/downloads') return json(route, { items: [] });
			if (path === '/api/models') return json(route, []);
			if (path === '/api/models/providers') return json(route, []);
			if (path === '/api/models/picks') return json(route, { picks: {} });
			if (path === '/api/sandbox-computer') return json(route, { approvals: 'sensitive' });
			if (path === '/api/host-control') return json(route, { status: { enabled: false, paused: false, platform: 'darwin' }, activity: { active: false, agent: null, summary: null }, settings: { agents: [], apps: [], workspaceFiles: [], defaultTier: 'bounded' }, tiers: {}, permissions: null, manifestHash: '' });
			if (/^\/api\/agents\/[^/]+\/proactive$/.test(path)) return json(route, { level: 'normal', levelSetting: null, effectiveLevel: 'normal', throttled: false, cfg: {}, cadenceMin: 30, budget: 0, usedToday: 0, nextHeartbeatAt: null, lastHeartbeatAt: null, followups: [] });
			if (/^\/api\/conversations\/[^/]+\/context$/.test(path)) return json(route, { tokens: null, contextWindow: null, percent: null, model: null, session: null });
			if (path.startsWith('/api/proactive/inbox')) return json(route, { items: [], count: 0, defaultLevel: 'normal' });
			let m = path.match(/^\/api\/rooms\/([^/]+)\/messages$/);
			if (m) {
				const limit = Number(url.searchParams.get('limit') ?? 200);
				const before = url.searchParams.get('before');
				count('roomMessages');
				return json(route, pageRoomMessages({ limit, ...(before !== null ? { before } : {}) }));
			}
			m = path.match(/^\/api\/rooms\/([^/]+)\/read$/);
			if (m) return json(route, { ok: true });
			return json(route, {});
		});
		await page.goto(`${BASE}/?room=room1`);
		await page.locator('.pa-scroll [data-mid]').first().waitFor({ timeout: 10000 });
		const firstIds = await idsInDom(page);
		assert.equal(firstIds.length, 50, `群聊首屏应只渲染 50 条，实际 ${firstIds.length}`);
		assert.equal(firstIds[0], 'r31');
		// 点「更早的消息」（RoomChat 的加载入口）
		await page.getByTestId('room-load-older').click();
		await page.waitForFunction(() => document.querySelectorAll('.pa-scroll [data-mid]').length === 80, null, { timeout: 8000 });
		const ids = await idsInDom(page);
		assert.deepEqual(ids, Array.from({ length: ROOMN }, (_, k) => `r${k + 1}`), '群聊上滑后应连续覆盖 r1..r80');
		assert.ok(reqs('roomMessages') >= 2);
		await context.close();
	});
} finally {
	console.log('\n==== 结果 ====');
	for (const [mark, name, err] of results) console.log(mark, name, err ? `\n   ${err}` : '');
	const failed = results.filter((r) => r[0] === '❌').length;
	console.log(`\n${results.length - failed}/${results.length} 通过`);
	if (browser) await browser.close();
	await new Promise((r) => wss.close(r));
	await new Promise((r) => web.close(r));
	process.exit(failed ? 1 : 0);
}
