import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { artifactDir } from "./fixtures/artifacts.mjs";

/**
 * 记忆后端下拉的定向验证：把「此助理的记忆后端」从原生 <select> 换成应用内统一 Select。
 *
 * 覆盖：不再有原生 <select>（告别系统黑灰弹层）；菜单 portal 到 body、z-index 高于设置弹窗；
 *      桌面 / 390 窄屏 / 760x420 矮窗都不溢出（clamp + 向上翻转）；长 label 截断 + tooltip；
 *      鼠标点选、方向键只移高亮（不误保存）、回车提交、Esc 只关菜单并复原焦点；
 *      保存中提示、保存失败显式报错且值回滚；PUT 持久化后刷新仍生效；设置 › 记忆的全局后端同样用 Select。
 *
 * 纯前端 fixture：静态托管 apps/web/dist，page.route 拦全部 /api，不启动服务端、不碰真实数据 / 钥匙串。
 * 运行前先构建：npm run build -w @pi-assistant/web
 */
const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const dist = join(root, 'apps/web/dist');
if (!existsSync(join(dist, 'index.html'))) {
	console.error('找不到 apps/web/dist/index.html；先跑 `npm run build -w @pi-assistant/web`');
	process.exit(2);
}
const SHOTS = artifactDir("screenshots");
mkdirSync(SHOTS, { recursive: true });

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

const now = Date.now();
const BASIC = { id: 'basic', name: '基础记忆（本机 SQLite）', capabilities: { reflect: true, mentalModels: false, temporal: false, graph: false, exportImport: true, mcpEndpoint: false } };
const HINDSIGHT = { id: 'hindsight', name: '高级记忆（Hindsight）', capabilities: { reflect: true, mentalModels: true, temporal: true, graph: true, exportImport: true, mcpEndpoint: true } };
let globalProvider = 'basic';
let agentProvider = null; // null = 跟随全局
let failNextAgentPut = false;
const log = { agentPut: [], globalPut: [] };

const hostInfo = { settings: { enabled: false, agents: 'all', apps: [], workspaceFiles: false, tiers: {}, defaultTier: 'bounded' }, tiers: {}, status: { enabled: false, tiers: {}, paused: false, daemon: { state: 'off', detail: '' }, platform: 'darwin', installed: false, version: '' }, manifest: '', manifestHash: '', permissions: null, activity: { active: false, agent: null, summary: null } };
const agents = [{ id: 'a1', name: '测试助理', avatar: '测', color: '#3b82f6', persona: '', description: '', status: 'idle', unread: 0, model: { provider: 'mock', id: 'mock' }, model_provider: 'mock', model_id: 'mock', workspace: '/tmp/ws/a1', scope: 'user' }];
const system = () => ({
	serverId: 'srv', publicKey: 'pk', pi: { version: '0.0.0', testedWith: '0.0.0', compatible: true, message: 'ok' },
	mock: true, local: true, owner: true, server: false, deviceId: 'dev', onboarded: true, modelSetupDone: true, modelReady: true,
	defaultModel: { provider: 'mock', id: 'mock' }, credentialBackend: 'file',
	sandbox: { mode: 'workspace', preference: 'workspace', dockerAvailable: false }, entryDomain: null,
	tunnel: { enabled: false, state: 'off', mode: 'quick', url: null, failures: 0, rendezvous: { state: 'off' }, binary: null, named: {} },
	workspaceRoot: '/tmp/ws', push: { publicKey: 'pk' }, seq: 1,
});
const activeProvider = () => (agentProvider === 'hindsight' ? HINDSIGHT : BASIC);

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', locale: 'zh-CN' });
await context.addInitScript(() => localStorage.setItem('pia.layout', JSON.stringify({ sideW: 264, paneW: 340, sideCollapsed: false, info: true })));
const page = await context.newPage();
page.setDefaultTimeout(15_000);
await page.route('**/api/**', async (route) => {
	const req = route.request();
	const p = new URL(req.url()).pathname;
	const method = req.method();
	const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
	const body = () => { try { return JSON.parse(req.postData() ?? '{}'); } catch { return {}; } };
	if (p === '/api/system') return json(system());
	if (p === '/api/system/public') return json({});
	if (p === '/api/agents' && method === 'GET') return json(agents);
	if (p === '/api/rooms') return json([]);
	if (p === '/api/channels') return json({ items: [], publicUrl: null });
	if (p === '/api/wechat') return json({ enabled: false, acknowledgedAt: null, agentIds: [] });
	if (p === '/api/downloads') return json({ items: [] });
	if (p.startsWith('/api/proactive/inbox')) return json({ items: [], count: 0, defaultLevel: 'normal' });
	if (p === '/api/devices') return json([]);
	if (p === '/api/models/providers') return json({ providers: [] });
	if (p === '/api/models') return json([]);
	if (p === '/api/host-control') return json(hostInfo);
	if (p.startsWith('/api/usage/summary')) return json({ totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unknownCalls: 0 } });
	if (p === '/api/skill-suggest') return json({ enabled: false });
	if (p === '/api/settings') return json({});
	if (p === '/api/memory/providers' && method === 'GET') return json({ global: globalProvider, providers: [BASIC, HINDSIGHT] });
	if (p === '/api/memory/provider' && method === 'PUT') { const id = body().id; log.globalPut.push(id); globalProvider = id; return json({ ok: true }); }
	if (p === '/api/memory/hindsight' && method === 'GET') return json({ status: { state: 'ready', detail: '', pending: 0 } });
	if (p === '/api/agents/a1/memory' && method === 'GET') return json({ provider: activeProvider(), agentProvider, items: [] });
	if (p === '/api/agents/a1/memory-provider' && method === 'PUT') {
		if (failNextAgentPut) { failNextAgentPut = false; return json({ error: '模拟保存失败' }, 500); }
		const id = body().id;
		log.agentPut.push(id);
		agentProvider = id;
		return json({ ok: true });
	}
	if (p === '/api/agents/a1/conversations') return json({ current: null, items: [] });
	if (p === '/api/agents/a1/messages') return json([]);
	if (p === '/api/subagents') return json([]);
	if (p === '/api/agents/a1/computer') return json({ separate: false, hasData: null, desktop: { enabled: false, state: 'off' } });
	if (p === '/api/agents/a1/files') return json([]);
	if (p === '/api/agents/a1/routines') return json([]);
	return json({});
});

const menuBox = async (testId) => await page.getByTestId(`${testId}-menu`).boundingBox();
const assertInsideViewport = (box, vp, label) => {
	assert.ok(box, `${label}: 没有菜单包围盒`);
	assert.ok(box.x >= -1 && box.y >= -1 && box.x + box.width <= vp.width + 1 && box.y + box.height <= vp.height + 1, `${label} 溢出视口: ${JSON.stringify({ box, vp })}`);
};
const openMemory = async () => {
	await page.getByTestId('info-tabs').waitFor();
	const tab = page.locator('[data-testid=info-tabs] [data-itab=memory]');
	if (await tab.count()) await tab.click();
	else {
		await page.getByTestId('info-tabs-more').click();
		await page.locator('[data-testid=info-tabs-menu] [data-itab=memory]').click();
	}
	// 记忆服务收在「高级」里
	const opts = page.getByTestId('memory-options');
	await opts.waitFor();
	if (!(await opts.evaluate((el) => el.open))) await opts.locator(':scope > summary').click();
	await page.getByTestId('memory-provider').waitFor();
};

try {
	// ---------------------------------------------------------------- 1) 桌面：不再是原生 select，菜单 portal + 夹取
	console.log('\n[1] 桌面：统一 Select 取代原生 <select>，菜单 portal 到 body、在视口内、层级高于设置弹窗');
	await page.goto(`${base}/?agent=a1`);
	await openMemory();
	assert.equal(await page.locator('[data-testid=memory-tab] select').count(), 0, '记忆页不应再有原生 <select>');
	await page.waitForFunction(() => document.querySelector('[data-testid=memory-provider]')?.textContent?.includes('跟随全局（基础记忆（本机 SQLite））'), null, { timeout: 5000 });
	assert.match(await page.getByTestId('memory-provider').innerText(), /跟随全局（基础记忆（本机 SQLite））/, '默认应显示「跟随全局（…）」');
	await page.getByTestId('memory-provider').click();
	const menu = page.getByTestId('memory-provider-menu');
	await menu.waitFor();
	assert.equal(await menu.getAttribute('role'), 'listbox', '菜单应是应用内 listbox');
	assert.equal(await menu.locator('[role=option]').count(), 3, '应有 3 个选项（跟随全局 / 基础 / 高级）');
	assert.ok(await menu.evaluate((el) => el.parentElement === document.body), '菜单应 portal 到 body，不被面板/弹窗裁剪');
	const z = await menu.evaluate((el) => Number(getComputedStyle(el).zIndex));
	assert.ok(z >= 60, `菜单 z-index 应高于设置弹窗(50)，实际 ${z}`);
	assertInsideViewport(await menuBox('memory-provider'), page.viewportSize(), '桌面菜单');
	assert.ok((await menuBox('memory-provider')).width >= 240, '长文案菜单应适度加宽');
	await page.screenshot({ path: join(SHOTS, 'memory-provider-select-desktop.png') });

	// ---------------------------------------------------------------- 2) Esc 只关菜单 + 焦点复原
	console.log('\n[2] Esc 只关菜单、不保存、把焦点还给按钮');
	await page.keyboard.press('Escape');
	await menu.waitFor({ state: 'detached' });
	assert.equal(log.agentPut.length, 0, 'Esc 关菜单不应保存');
	assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'memory-provider', 'Esc 后焦点应回到按钮');

	// ---------------------------------------------------------------- 3) 方向键只移高亮、回车提交
	console.log('\n[3] 方向键只移高亮（不误保存），回车才提交');
	await page.getByTestId('memory-provider').press('ArrowDown'); // 打开
	await page.getByTestId('memory-provider-menu').waitFor();
	await page.keyboard.press('ArrowDown'); // 高亮移到「基础记忆」
	await page.waitForTimeout(200);
	assert.equal(log.agentPut.length, 0, '方向键不应直接触发保存');
	await page.keyboard.press('Enter');
	await page.waitForFunction(() => document.querySelector('[data-testid=memory-provider]')?.textContent?.includes('基础记忆（本机 SQLite）'), null, { timeout: 5000 });
	assert.deepEqual(log.agentPut, ['basic'], '回车应提交当前高亮项');
	assert.equal(agentProvider, 'basic', 'PUT 应落库');

	// ---------------------------------------------------------------- 4) 保存失败：显式报错 + 值回滚
	console.log('\n[4] 保存失败显式提示，值回滚（不静默美化）');
	failNextAgentPut = true;
	await page.getByTestId('memory-provider').click();
	await page.getByTestId('memory-provider-option-hindsight').click();
	await page.getByTestId('memory-provider-error').waitFor();
	assert.match(await page.getByTestId('memory-provider-error').innerText(), /切换失败/, '失败应有可见错误');
	assert.equal(agentProvider, 'basic', '失败不应改后端');
	assert.match(await page.getByTestId('memory-provider').innerText(), /基础记忆（本机 SQLite）/, '失败后应回滚到原值');

	// ---------------------------------------------------------------- 5) 持久化：刷新后仍生效
	console.log('\n[5] 刷新后仍显示已保存的后端');
	await page.reload();
	await openMemory();
	await page.waitForFunction(() => document.querySelector('[data-testid=memory-provider]')?.textContent?.includes('基础记忆（本机 SQLite）'), null, { timeout: 5000 });
	assert.match(await page.getByTestId('memory-provider').innerText(), /基础记忆（本机 SQLite）/, '刷新后应保留所选后端');

	// ---------------------------------------------------------------- 6) 390 窄屏：长 label 不撑破、菜单在视口内
	console.log('\n[6] 390 窄屏：不横向溢出、菜单夹在视口内、按钮带完整 tooltip');
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByTestId('memory-provider').waitFor();
	const overflow = await page.evaluate(() => { const el = document.querySelector('[data-testid=memory-tab]'); return { sw: el.scrollWidth, cw: el.clientWidth }; });
	assert.ok(overflow.sw <= overflow.cw + 1, `记忆页横向溢出: ${JSON.stringify(overflow)}`);
	const tip = await page.getByTestId('memory-provider').getAttribute('title');
	assert.ok(tip && tip.includes('基础记忆（本机 SQLite）'), `按钮 tooltip 应是完整 label，实际 ${tip}`);
	await page.getByTestId('memory-provider').click();
	await page.getByTestId('memory-provider-menu').waitFor();
	assertInsideViewport(await menuBox('memory-provider'), page.viewportSize(), '390 菜单');
	await page.screenshot({ path: join(SHOTS, 'memory-provider-select-390.png') });
	await page.keyboard.press('Escape');

	// ---------------------------------------------------------------- 7) 760x420 矮窗：向上翻转 / 限高不溢出
	console.log('\n[7] 760x420 矮窗：菜单向上翻转并限高，不溢出');
	await page.setViewportSize({ width: 760, height: 420 });
	await page.getByTestId('memory-provider').waitFor();
	await page.getByTestId('memory-provider').click();
	await page.getByTestId('memory-provider-menu').waitFor();
	assertInsideViewport(await menuBox('memory-provider'), page.viewportSize(), '矮窗菜单');
	await page.screenshot({ path: join(SHOTS, 'memory-provider-select-short.png') });
	await page.keyboard.press('Escape');

	// ---------------------------------------------------------------- 8) 设置 › 记忆：全局后端也用统一 Select
	console.log('\n[8] 设置 › 记忆：全局后端同样用应用内 Select 并可保存');
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`${base}/?settings=memory`);
	await page.getByTestId('memory-global-provider').waitFor();
	await page.getByTestId('memory-global-provider').click();
	await page.getByTestId('memory-global-provider-option-hindsight').click();
	await page.waitForFunction(() => document.querySelector('[data-testid=memory-global-provider]')?.textContent?.includes('高级记忆（Hindsight）'), null, { timeout: 5000 });
	assert.deepEqual(log.globalPut, ['hindsight'], '全局后端 PUT 应发出');
	assert.equal(globalProvider, 'hindsight', '全局后端应落库');
	await page.screenshot({ path: join(SHOTS, 'memory-settings-global.png') });

	console.log('\n✅ 记忆后端统一 Select：全部通过');
} finally {
	await browser.close();
	web.close();
}
