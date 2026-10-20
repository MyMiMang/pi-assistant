// 手机聊天历史分页 / 上滑加载 / 引用跳转（context 窗口导航）的纯前端 fixture 测试。
//
// 静态托管 apps/web/dist，用 page.route 拦截所有 /api，用真实 WebSocket 推一条新消息，
// 不启动 packages/server/src/main.ts：不碰系统钥匙串、不读写用户真实数据、不调付费模型。
//
// 覆盖：
//   1. 首屏有界：只拉 limit=50（不是旧版 300），渲染条数随 limit 有界；
//   2. 单聊上滑加载更早：稳定复合游标 before/beforeSeq，插入上方后按高度差回填锚点；
//   3. 往上翻（stick=false）时新消息不把视图拉到底；
//   4. 引用跳未加载的旧消息：**一次有界 context 窗口**替换列表（不把沿途历史全加载、不留空洞），
//      「加载较新消息」前向分页到最新，「回到最新」恢复最近一页；
//   5. 10k 历史跳最早：只发一次有界 context，不把 10k 条进 DOM；
//   6. 历史窗口里 WS 新消息不跨 gap 合入，只计数提示；回到最新后可见；
//   7. 群聊上滑加载更早（before=seq）；
//   8. 群聊引用跳远：同样一次 context 窗口 + 回到最新。
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

// 120 条单聊 + 80 条群聊，created_at / seq 单调递增；最后一条引用最早那条（未加载），供引用跳转用
const N = 120;
const ROOMN = 80;
const BIG_N = 10000;
const msg = (id, agentId, convId, content, i, extra = {}) => ({ id, agent_id: agentId, conversation_id: convId, task_id: null, role: 'user', content, meta: {}, status: 'done', created_at: 1000 + i, updated_at: 1000 + i, seq: i, ...extra });
const ROOM_CAPS = { maxTurns: 6, maxDepth: 1, perAgent: 3, followup: true };
const ROOM_OBJ = { id: 'room1', name: '群一', purpose: '', managerId: 'a1', unread: 0, paused: null, caps: ROOM_CAPS, state: { running: false, current: null, queue: [] }, members: [{ agentId: 'a1', conversationId: 'c1', name: '甲', avatar: '甲', color: '#888', sort: 0 }] };

const replyTo = (source, target, excerpt) => ({ messageId: target, author: { id: '', name: '我', role: 'user' }, source, excerpt, truncated: false, edited: false, createdAt: 1001 });
const AGENT_MSGS = Array.from({ length: N }, (_, k) => {
	const i = k + 1;
	if (i === N) return msg(`m${i}`, 'a1', 'c1', `第 ${i} 条`, i, { replyToId: 'm1', reply: replyTo({ kind: 'conversation', id: 'c1' }, 'm1', '第 1 条') });
	return msg(`m${i}`, 'a1', 'c1', `第 ${i} 条`, i);
});
const ROOM_MSGS = Array.from({ length: ROOMN }, (_, k) => {
	const i = k + 1;
	const base = { ...msg(`r${i}`, 'a1', null, `群消息 ${i}`, i), room_id: 'room1' };
	if (i === ROOMN) return { ...base, replyToId: 'r1', reply: replyTo({ kind: 'room', id: 'room1' }, 'r1', '群消息 1') };
	return base;
});
// 大历史：只用于「跳最早只发一次有界 context、不把 10k 进 DOM」
const BIG_MSGS = Array.from({ length: BIG_N }, (_, k) => {
	const i = k + 1;
	if (i === BIG_N) return msg(`b${i}`, 'a1', 'c1', `大历史 ${i}`, i, { replyToId: 'b1', reply: replyTo({ kind: 'conversation', id: 'c1' }, 'b1', '大历史 1') });
	return msg(`b${i}`, 'a1', 'c1', `大历史 ${i}`, i);
});

// 数据集可替换：大历史用例把 AGENT_DATA 换成 10000 条
let AGENT_DATA = AGENT_MSGS;
let ROOM_DATA = ROOM_MSGS;
const pageAgentMessages = ({ limit, before, beforeSeq, after, afterSeq }) => {
	const all = AGENT_DATA;
	if (after !== undefined || afterSeq !== undefined) {
		const a = after !== undefined ? Number(after) : 0;
		const as = afterSeq !== undefined ? Number(afterSeq) : Number.NEGATIVE_INFINITY;
		return all.filter((m) => m.created_at > a || (m.created_at === a && m.seq > as)).slice(0, limit);
	}
	const b = before !== undefined ? Number(before) : Number.MAX_SAFE_INTEGER;
	const bs = beforeSeq !== undefined ? Number(beforeSeq) : Number.MAX_SAFE_INTEGER;
	return all.filter((m) => m.created_at < b || (m.created_at === b && m.seq < bs)).slice(-limit);
};
const pageRoomMessages = ({ limit, before, after }) => {
	const all = ROOM_DATA;
	if (after !== undefined) return all.filter((m) => m.seq > Number(after)).slice(0, limit);
	const filtered = before !== undefined ? all.filter((m) => m.seq < Number(before)) : all;
	return filtered.slice(-limit);
};

function reset() {
	AGENT_DATA = AGENT_MSGS;
	ROOM_DATA = ROOM_MSGS;
	return { requests: {}, convs: { a1: { current: 'c1', items: [{ id: 'c1', agent_id: 'a1', title: '主对话', created_at: 1, updated_at: 2, message_count: N, last: { content: `第 ${N} 条`, role: 'user', created_at: 1000 + N } }] } } };
}
let S = reset();
const count = (k) => (S.requests[k] = (S.requests[k] ?? 0) + 1);
const reqs = (k) => S.requests[k] ?? 0;

/** 统一 route 处理器：单聊 / 群聊 / context 窗口 / 前后分页都在这里，避免各测试各写一套。 */
async function routeApi(route) {
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
	// 引用定位：有界 context 窗口（同容器前后各 ≤25）；bounds=1 额外回 hasOlder/hasNewer
	m = path.match(/^\/api\/messages\/([^/]+)\/context$/);
	if (m) {
		const mid = m[1];
		const pool = url.searchParams.get('roomId') ? ROOM_DATA : AGENT_DATA;
		const target = pool.find((x) => x.id === mid);
		if (!target) return json({ error: 'not_found' }, 404);
		count('context');
		const win = pool.filter((x) => x.seq >= target.seq - 25 && x.seq <= target.seq + 25);
		if (url.searchParams.get('bounds') === '1') {
			const lo = Math.min(...pool.map((x) => x.seq));
			const hi = Math.max(...pool.map((x) => x.seq));
			return json({ messages: win, hasOlder: win.length > 0 && win[0].seq > lo, hasNewer: win.length > 0 && win[win.length - 1].seq < hi });
		}
		return json(win);
	}
	m = path.match(/^\/api\/agents\/([^/]+)\/messages$/);
	if (m) {
		const limit = Number(url.searchParams.get('limit') ?? 200);
		const before = url.searchParams.get('before');
		const beforeSeq = url.searchParams.get('beforeSeq');
		const after = url.searchParams.get('after');
		const afterSeq = url.searchParams.get('afterSeq');
		count('agentMessages');
		if (url.searchParams.get('conversation')) count('agentMessagesConv');
		return json(pageAgentMessages({ limit, ...(before !== null ? { before } : {}), ...(beforeSeq !== null ? { beforeSeq } : {}), ...(after !== null ? { after } : {}), ...(afterSeq !== null ? { afterSeq } : {}) }));
	}
	m = path.match(/^\/api\/rooms\/([^/]+)\/messages$/);
	if (m) {
		const limit = Number(url.searchParams.get('limit') ?? 200);
		const before = url.searchParams.get('before');
		const after = url.searchParams.get('after');
		count('roomMessages');
		return json(pageRoomMessages({ limit, ...(before !== null ? { before } : {}), ...(after !== null ? { after } : {}) }));
	}
	m = path.match(/^\/api\/rooms\/([^/]+)\/read$/);
	if (m) return json({ ok: true });
	return json({});
}

async function makePage(browser, viewport, url = '/?agent=a1') {
	const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
	await context.addInitScript(([k, v]) => localStorage.setItem(k, v), [SEL_KEY, JSON.stringify({ agentId: 'a1', convs: { a1: 'c1' } })]);
	const page = await context.newPage();
	page.on('dialog', (d) => void d.dismiss());
	await page.route('**/api/**', routeApi);
	await page.goto(`${BASE}${url}`);
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
		await context.close();
	});

	await step('[手机390] 上滑加载更早：稳定复合游标 before/beforeSeq + 插入后锚点回填不跳', async () => {
		S = reset();
		const { page, context } = await makePage(browser, { width: 390, height: 844 });
		await page.locator('.pa-scroll [data-mid]').first().waitFor();
		// 先把滚动条拉到顶（触发自动加载更早），同时记录锚点消息 m71 的位置
		await page.evaluate(() => {
			const el = document.querySelector('.pa-scroll');
			el.scrollTop = 0;
			el.dispatchEvent(new Event('scroll'));
		});
		await page.waitForFunction(() => document.querySelectorAll('.pa-scroll [data-mid]').length === 100, null, { timeout: 8000 });
		const ids = await idsInDom(page);
		assert.equal(ids[0], 'm21', `应无缝插到 m21，实际 ${ids[0]}（共 request=${reqs('agentMessages')}，len=${ids.length}）`);
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
		// 继续上滑还能加载更早，直到 m1，全程连续。真实手势：先离开顶部（>=200px）再滑回顶部。
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

	await step('[手机390] 引用跳未加载的旧消息：一次有界 context 窗口，可加载较新 / 回到最新', async () => {
		S = reset();
		const { page, context } = await makePage(browser, { width: 390, height: 844 });
		await page.locator('.pa-scroll [data-mid]').first().waitFor();
		// 点最后一条消息里的引用块（引用最早的 m1，未加载）
		await page.locator('.pa-scroll [data-mid="m120"] [data-testid="quoted-block"]').click();
		// 目标应被定位：列表切换成围绕 m1 的连续窗口（m1..m26），不是把沿途 120 条全加载
		await page.locator('.pa-scroll [data-mid="m1"]').first().waitFor({ timeout: 10000 });
		assert.equal(reqs('context'), 1, `跳转应只发一次有界 context，实际 ${reqs('context')}`);
		assert.equal(reqs('agentMessages'), 1, `跳转不应为了跳一条把沿途历史全分页加载，实际历史请求 ${reqs('agentMessages')}`);
		const win = await idsInDom(page);
		assert.deepEqual(win, Array.from({ length: 26 }, (_, k) => `m${k + 1}`), `应显示围绕目标的连续窗口 m1..m26，实际 ${win.length} 条`);
		await page.getByTestId('history-window').waitFor();
		assert.ok(await page.getByTestId('history-return-latest').isVisible());
		// 「加载较新消息」前向分页：窗口向前接到 m76，仍连续无洞
		await page.getByTestId('history-load-newer').click();
		await page.waitForFunction(() => document.querySelectorAll('.pa-scroll [data-mid]').length === 76, null, { timeout: 8000 });
		const grown = await idsInDom(page);
		assert.deepEqual(grown, Array.from({ length: 76 }, (_, k) => `m${k + 1}`), '前向分页后应连续覆盖 m1..m76，无洞无重复');
		// 「回到最新」：恢复最近 50 条并清掉窗口状态
		await page.getByTestId('history-return-latest').click();
		await page.waitForFunction(() => document.querySelectorAll('.pa-scroll [data-mid]').length === 50, null, { timeout: 8000 });
		const latest = await idsInDom(page);
		assert.deepEqual(latest, Array.from({ length: 50 }, (_, k) => `m${k + 71}`), '回到最新应恢复 m71..m120');
		assert.equal(await page.getByTestId('history-window').count(), 0, '回到最新后不应再显示历史窗口提示');
		await context.close();
	});

	await step('[手机390] 10k 历史跳最早：只发一次有界 context，不把 10k 条进 DOM', async () => {
		S = reset();
		AGENT_DATA = BIG_MSGS;
		S.convs.a1.items[0].message_count = BIG_N;
		const { page, context } = await makePage(browser, { width: 390, height: 844 });
		await page.locator('.pa-scroll [data-mid]').first().waitFor({ timeout: 10000 });
		await page.locator('.pa-scroll [data-mid="b10000"] [data-testid="quoted-block"]').click();
		await page.locator('.pa-scroll [data-mid="b1"]').first().waitFor({ timeout: 10000 });
		assert.equal(reqs('context'), 1, `10k 历史跳最早应只发一次有界 context，实际 ${reqs('context')}`);
		assert.equal(reqs('agentMessages'), 1, `不应为了跳最早而分页加载沿途历史，实际 ${reqs('agentMessages')}`);
		const win = await idsInDom(page);
		assert.ok(win.length <= 60, `DOM 必须有界（≤60），实际 ${win.length} 条（10k 进 DOM 会打爆手机）`);
		assert.equal(win[0], 'b1');
		assert.equal(win.at(-1), 'b26');
		await context.close();
	});

	await step('[手机390] 历史窗口里 WS 新消息不跨 gap 合入，只计数提示；回到最新后可见', async () => {
		S = reset();
		const { page, context } = await makePage(browser, { width: 390, height: 844 });
		await page.locator('.pa-scroll [data-mid]').first().waitFor();
		await waitWs();
		await page.locator('.pa-scroll [data-mid="m120"] [data-testid="quoted-block"]').click();
		await page.locator('.pa-scroll [data-mid="m1"]').first().waitFor({ timeout: 10000 });
		// 让 mock 数据集也包含新消息，供「回到最新」拉取
		AGENT_DATA = [...AGENT_DATA, msg('m121', 'a1', 'c1', '窗口外新消息', 121)];
		pushEvent({ type: 'message.created', message: { ...msg('m121', 'a1', 'c1', '窗口外新消息', 121), conversation_id: 'c1' } });
		await page.waitForTimeout(200);
		const win = await idsInDom(page);
		assert.ok(!win.includes('m121'), '历史窗口里新消息不能跨 gap 直接追加（会让中段历史不可达）');
		assert.deepEqual(win, Array.from({ length: 26 }, (_, k) => `m${k + 1}`), '窗口内容不应被新消息改动');
		await page.getByTestId('history-window').getByText(/有 1 条新消息/).waitFor({ timeout: 5000 });
		await page.getByTestId('history-return-latest').click();
		await page.locator('.pa-scroll [data-mid="m121"]').waitFor({ timeout: 8000 });
		await context.close();
	});

	await step('[桌面] 群聊上滑加载更早：before=seq，插入上方保锚点', async () => {
		S = reset();
		const { page, context } = await makePage(browser, { width: 1280, height: 900 }, '/?room=room1');
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

	await step('[桌面] 群聊引用跳远：一次 context 窗口 + 回到最新', async () => {
		S = reset();
		const { page, context } = await makePage(browser, { width: 1280, height: 900 }, '/?room=room1');
		await page.locator('.pa-scroll [data-mid]').first().waitFor({ timeout: 10000 });
		await page.locator('.pa-scroll [data-mid="r80"] [data-testid="quoted-block"]').click();
		await page.locator('.pa-scroll [data-mid="r1"]').first().waitFor({ timeout: 10000 });
		assert.equal(reqs('context'), 1, `群聊引用跳应只发一次有界 context，实际 ${reqs('context')}`);
		const win = await idsInDom(page);
		assert.deepEqual(win, Array.from({ length: 26 }, (_, k) => `r${k + 1}`), '群聊应显示围绕目标的连续窗口 r1..r26');
		await page.getByTestId('history-return-latest').click();
		await page.waitForFunction(() => document.querySelectorAll('.pa-scroll [data-mid]').length === 50, null, { timeout: 8000 });
		const latest = await idsInDom(page);
		assert.deepEqual(latest, Array.from({ length: 50 }, (_, k) => `r${k + 31}`), '群聊回到最新应恢复 r31..r80');
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
