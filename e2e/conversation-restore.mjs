// 手机 / 电脑「上次打开的助理和对话」恢复 + 聊天记录加载体验的纯前端 fixture 测试。
//
// 走纯前端 fixture：静态托管 apps/web/dist，用 page.route 拦截所有 /api，不启动
// packages/server/src/main.ts，因此不碰系统钥匙串、不读写用户真实数据、不调付费模型。
// 覆盖：fresh / stored 有效 / 已删除 id / deeplink / 慢 agents 竞态 / 切对话晚返回 /
//       加载失败重试 / 空对话 / 乐观消息不被迟到 history 覆盖。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

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
// WebSocket 升级：应用会尝试连 /ws；没有真实服务时直接断开即可（不影响本测试）
web.on('upgrade', (_req, socket) => socket.destroy());
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
const AGENTS = [agent('a1', '甲'), agent('a2', '乙')];
const msg = (id, agentId, convId, content, created_at) => ({ id, agent_id: agentId, conversation_id: convId, task_id: null, role: 'user', content, meta: {}, status: 'done', created_at, updated_at: created_at });
const conv = (id, agentId, title, last) => ({ id, agent_id: agentId, title, created_at: 1, updated_at: 2, message_count: 1, last });

const MSGS = {
	c1: [msg('m1', 'a1', 'c1', '旧对话消息', 1000)],
	c2: [msg('m2', 'a1', 'c2', '新对话消息', 2000)],
	c2b: [msg('m3', 'a2', 'c2b', '乙的消息', 1000)],
	c_empty: [],
};

/** 每个场景用独立 state，避免互相影响 */
function reset() {
	return {
		agentsDelay: 0,
		msgDelay: {},
		failMessages: 0, // 让接下来的 N 次 messages 请求返回 500
		requests: {},
		convs: {
			a1: { current: 'c1', items: [conv('c1', 'a1', '对话一', '旧对话消息'), conv('c2', 'a1', '对话二', '新对话消息')] },
			a2: { current: 'c2b', items: [conv('c2b', 'a2', '对话二', '乙的消息')] },
		},
	};
}
let S = reset();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const count = (k) => (S.requests[k] = (S.requests[k] ?? 0) + 1);

async function makePage(browser, viewport, { stored } = {}) {
	const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
	if (stored !== undefined) {
		await context.addInitScript(([k, v]) => localStorage.setItem(k, v), [SEL_KEY, JSON.stringify(stored)]);
	}
	const page = await context.newPage();
	page.on('dialog', (d) => void d.dismiss());
	await page.route('**/api/**', async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const path = url.pathname;
		const method = req.method();
		const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
		if (path === '/api/system') return json(system);
		if (path === '/api/agents') {
			count('agents');
			if (S.agentsDelay) await sleep(S.agentsDelay);
			return json(AGENTS);
		}
		if (path === '/api/rooms') return json([]);
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
		m = path.match(/^\/api\/agents\/([^/]+)\/messages$/);
		if (m) {
			const convId = url.searchParams.get('conversation');
			count(`messages:${convId}`);
			if (S.failMessages > 0) {
				S.failMessages -= 1;
				return json({ error: '模拟加载失败' }, 500);
			}
			if (S.msgDelay[convId]) await sleep(S.msgDelay[convId]);
			return json(MSGS[convId] ?? []);
		}
		return json({});
	});
	await page.goto(`${BASE}/`);
	return { page, context };
}
const selRaw = (page) => page.evaluate((k) => localStorage.getItem(k), SEL_KEY);
const header = (page) => page.locator('[data-testid=main-conversation] header b').first();
/** 只在聊天正文里找文本，避开对话菜单里的 last 摘要 */
const thread = (page, text) => page.locator('.pa-thread-body').getByText(text, { exact: true });

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

	for (const [label, viewport] of [['桌面', { width: 1280, height: 900 }], ['手机390', { width: 390, height: 844 }]]) {
		await step(`[${label}] 恢复上次明确打开的助理和对话（不是列表第一个）`, async () => {
			S = reset();
			const { page, context } = await makePage(browser, viewport, { stored: { agentId: 'a2', convs: { a2: 'c2b' } } });
			await header(page).filter({ hasText: '乙' }).waitFor();
			assert.equal(await header(page).textContent(), '乙');
			assert.ok((await page.getByTestId('conv-menu').textContent()).includes('对话二'));
			// 有效选择不被覆盖
			assert.equal(JSON.parse(await selRaw(page)).agentId, 'a2');
			await context.close();
		});

		await step(`[${label}] 上次的助理已删除：回退第一个并只回写一次`, async () => {
			S = reset();
			const { page, context } = await makePage(browser, viewport, { stored: { agentId: 'gone', convs: {} } });
			await header(page).filter({ hasText: '甲' }).waitFor();
			assert.equal(JSON.parse(await selRaw(page)).agentId, 'a1');
			await context.close();
		});
	}

	await step('[桌面] deeplink ?agent= 优先于本地记录', async () => {
		S = reset();
		const { page, context } = await makePage(browser, { width: 1280, height: 900 }, { stored: { agentId: 'a1', convs: {} } });
		await page.goto(`${BASE}/?agent=a2`);
		await header(page).filter({ hasText: '乙' }).waitFor();
		assert.equal(await header(page).textContent(), '乙');
		await context.close();
	});

	await step('[手机390] 慢 agents：加载期间不把本地有效选择覆盖成第一个', async () => {
		S = reset();
		S.agentsDelay = 700;
		const { page, context } = await makePage(browser, { width: 390, height: 844 }, { stored: { agentId: 'a2', convs: { a2: 'c2b' } } });
		// agents 还没回来时：不能已经写了 a1
		await sleep(250);
		const during = JSON.parse((await selRaw(page)) ?? '{}');
		assert.equal(during.agentId, 'a2');
		await header(page).filter({ hasText: '乙' }).waitFor();
		assert.equal(await header(page).textContent(), '乙');
		await context.close();
	});

	await step('[手机390] 切对话：晚返回的旧请求不覆盖新目标，切换时不闪旧聊天', async () => {
		S = reset();
		S.msgDelay = { c1: 1800, c2: 40 };
		const { page, context } = await makePage(browser, { width: 390, height: 844 }, { stored: { agentId: 'a1', convs: { a1: 'c1' } } });
		// 初始 c1 还在加载 → 显示骨架而不是白屏 / 旧内容
		await page.getByTestId('thread-loading').waitFor();
		await page.getByTestId('conv-menu').click();
		await page.locator('[role=menu]').getByText('对话二').click();
		// 切到 c2 后立即显示目标 loading，且不显示旧对话内容
		assert.equal(await thread(page, '旧对话消息').count(), 0);
		await thread(page, '新对话消息').waitFor();
		// 等旧请求（c1）晚返回，仍不能覆盖 c2
		await sleep(2200);
		assert.equal(await thread(page, '新对话消息').count(), 1);
		assert.equal(await thread(page, '旧对话消息').count(), 0);
		// 只对当前目标发了一次历史请求
		assert.equal(S.requests['messages:c2'], 1);
		await context.close();
	});

	await step('[桌面] 初次加载失败：显示错误 + 重试成功（不永远 loading）', async () => {
		S = reset();
		S.failMessages = 1;
		const { page, context } = await makePage(browser, { width: 1280, height: 900 }, { stored: { agentId: 'a1', convs: { a1: 'c1' } } });
		await page.getByTestId('thread-error').waitFor();
		assert.equal(await page.getByTestId('thread-loading').count(), 0);
		await page.getByTestId('thread-retry').click();
		await thread(page, '旧对话消息').waitFor();
		await context.close();
	});

	await step('[桌面] 空对话：显示「还没有消息」而不是一直骨架', async () => {
		S = reset();
		S.convs.a1 = { current: 'c_empty', items: [conv('c_empty', 'a1', '空对话', null)] };
		const { page, context } = await makePage(browser, { width: 1280, height: 900 }, { stored: { agentId: 'a1', convs: { a1: 'c_empty' } } });
		await page.getByTestId('thread-empty').waitFor();
		assert.equal(await page.getByTestId('thread-loading').count(), 0);
		await context.close();
	});

	await step('[桌面] 后台刷新（重新拉取）不清空已显示消息、不闪骨架', async () => {
		S = reset();
		const { page, context } = await makePage(browser, { width: 1280, height: 900 }, { stored: { agentId: 'a1', convs: { a1: 'c1' } } });
		await thread(page, '旧对话消息').waitFor();
		// 点侧边栏同一个助理 = 重新 selectAgent（等同重连后的重新拉取）
		await page.getByTestId('sidebar-agent').filter({ hasText: '甲' }).click();
		await sleep(300);
		assert.equal(await thread(page, '旧对话消息').count(), 1);
		assert.equal(await page.getByTestId('thread-loading').count(), 0);
		await context.close();
	});
} finally {
	await browser?.close();
	web.close();
}

const failed = results.filter(([s]) => s === '❌');
console.log(`\nconversation-restore: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
