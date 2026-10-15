import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

// 渠道删除按钮的 UI 链路测试：真实按钮 → 自绘确认框（不是原生 confirm）→ DELETE。
// 走“纯前端 fixture”：静态托管 apps/web/dist，用 page.route 拦截所有 /api，
// 不启动 packages/server/src/main.ts，因此不会碰系统钥匙串、也不碰真实渠道数据。
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
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${web.address().port}`;

const system = {
	serverId: 'srv', publicKey: 'pk', pi: { version: '0.0.0', testedWith: '0.0.0', compatible: true, message: 'ok' },
	mock: true, local: true, owner: true, server: false, deviceId: 'dev', onboarded: true, modelSetupDone: true,
	defaultModel: { provider: 'mock', id: 'mock' }, credentialBackend: 'file',
	sandbox: { mode: 'workspace', preference: 'workspace', dockerAvailable: false }, entryDomain: null,
	tunnel: { enabled: false, state: 'off', mode: 'quick', url: null, failures: 0, rendezvous: { state: 'off' }, binary: null, named: {} },
	workspaceRoot: '/tmp/ws', push: { publicKey: 'pk' }, seq: 1,
};

// 正常连接 + 凭据无法解密的坏连接（去掉 botToken 密文即可，DELETE 不需要解密）
const fixtures = () => [
	{ id: 'ch_good', kind: 'wechat_clawbot', name: '微信 ClawBot', agentId: 'a1', enabled: true, config: { accountId: 'bot1@im.bot' }, secretsSet: ['botToken'], bindCode: null, status: { state: 'online', detail: '已连接（单聊）' }, users: [{ id: 'o9cq805HM@im.wechat', display: null, allowed: true, lastAt: null }], queued: 3 },
	{ id: 'ch_bad', kind: 'wechat_clawbot', name: '微信 ClawBot', agentId: 'a1', enabled: true, config: { accountId: 'owner@im.wechat' }, secretsSet: [], bindCode: null, status: { state: 'error', detail: '微信凭据无法解密，请重新扫码连接' }, users: [{ id: 'owner@im.wechat', display: null, allowed: true, lastAt: null }], queued: 0 },
];
let channels = fixtures();
let failNextDelete = false;
let slowDelete = false;
const deletes = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
try {
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
	const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
	const page = await context.newPage();
	let nativeDialogs = 0;
	page.on('dialog', (d) => { nativeDialogs++; void d.dismiss(); });

	const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
	await page.route('**/api/**', async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		const method = req.method();
		if (path === '/api/system') return json(route, system);
		if (path === '/api/agents') return json(route, []);
		if (path === '/api/rooms') return json(route, []);
		if (path === '/api/channels' && method === 'GET') return json(route, { items: channels, publicUrl: null });
		if (path === '/api/wechat' && method === 'GET') return json(route, { enabled: false, acknowledgedAt: null, agentIds: [] });
		if (path === '/api/downloads') return json(route, { items: [] });
		if (path.startsWith('/api/proactive/inbox')) return json(route, { items: [], count: 0, defaultLevel: 'normal' });
		const m = path.match(/^\/api\/channels\/([^/]+)$/);
		if (m && method === 'DELETE') {
			const id = decodeURIComponent(m[1]);
			deletes.push(id);
			if (failNextDelete) { failNextDelete = false; return json(route, { error: '模拟删除失败' }, 500); }
			if (slowDelete) await sleep(700);
			channels = channels.filter((c) => c.id !== id);
			return json(route, { ok: true });
		}
		return json(route, {});
	});

	const rows = () => page.locator('[data-testid=channel-wechat_clawbot]');
	await page.goto(`${base}/?settings=channels`);
	await page.getByTestId('settings-dialog').waitFor();
	await page.getByTestId('channels').waitFor();
	assert.equal(await rows().count(), 2, '应显示两条微信 ClawBot 连接（正常 + 坏凭据）');
	assert.match(await rows().nth(1).textContent(), /微信凭据无法解密/, '坏凭据行的错误文案应可见');

	// 1) 取消：不删除、零请求
	await page.getByTestId('channel-delete-ch_good').click();
	const dlg = page.getByTestId('confirm-dialog');
	await dlg.waitFor();
	const dlgText = await dlg.textContent();
	assert.match(dlgText, /断开并删除/, '确认框标题');
	assert.match(dlgText, /对话记录都会保留/, '确认框需说明只删连接、保留助理与对话');
	await page.getByTestId('confirm-cancel').click();
	assert.equal(deletes.length, 0, '取消不应发出 DELETE');
	assert.equal(await rows().count(), 2, '取消后连接仍在');

	// 2) 服务端失败：显示用户可理解的文案，连接保留，可重试
	failNextDelete = true;
	await page.getByTestId('channel-delete-ch_good').click();
	await page.getByTestId('confirm-ok').click();
	await page.getByText(/删除失败.*模拟删除失败/).waitFor();
	assert.equal(await rows().count(), 2, '删除失败时连接保留');
	assert.deepEqual(deletes, ['ch_good'], '失败重试前已发出一次 DELETE');
	deletes.length = 0;

	// 3) 删除中按钮禁用（防双击）；慢响应期间只发一次 DELETE
	slowDelete = true;
	await page.getByTestId('channel-delete-ch_good').click();
	await page.getByTestId('confirm-ok').dblclick();
	await page.waitForTimeout(120);
	assert.ok(await page.getByTestId('channel-delete-ch_good').isDisabled(), '删除进行中按钮应禁用');
	await page.waitForTimeout(900);
	assert.deepEqual(deletes, ['ch_good'], '慢删除期间只发一次 DELETE，且目标正确');
	assert.equal(await rows().count(), 1, '删除成功后列表刷新，坏凭据行仍在');
	slowDelete = false;
	deletes.length = 0;

	// 4) 凭据无法解密的连接也能删除（不需要解密），确认一次真正 DELETE 目标
	await page.getByTestId('channel-delete-ch_bad').click();
	await page.getByTestId('confirm-ok').click();
	await page.getByTestId('clawbot-section').getByText('扫码连接微信').waitFor();
	assert.deepEqual(deletes, ['ch_bad'], '确认一次应只 DELETE 目标连接');
	assert.equal(await rows().count(), 0, '坏凭据连接也能被移除');

	// 5) 窄屏（390）下两行仍可见、按钮可点
	channels = fixtures();
	await page.setViewportSize({ width: 390, height: 780 });
	await page.reload();
	await page.getByTestId('channels').waitFor();
	assert.equal(await rows().count(), 2, '390 宽下两行仍在');
	await page.getByTestId('channel-delete-ch_bad').scrollIntoViewIfNeeded();
	assert.ok(await page.getByTestId('channel-delete-ch_bad').isVisible(), '390 宽下删除按钮可见');

	assert.equal(nativeDialogs, 0, '不得调用原生 confirm/alert/prompt');
	console.log('通过：渠道删除走自绘确认框；取消零请求、失败保留并提示、删除中禁用防双击、坏凭据连接可删、无原生 confirm。');
} finally {
	await browser?.close();
	web.close();
}
