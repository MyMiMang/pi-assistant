import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

/**
 * 原生 dialog 同类 UI 根治的定向验证：把残留的 window.confirm / alert / prompt 全部换成
 * 应用内共享 useConfirm / Modal，验证“取消 0 请求、确认一次才发请求、失败可见、删除中防双击、
 * Esc 只关当前层不关底层、390 窄屏可用、全程不弹原生对话框”。
 *
 * 纯前端 fixture：静态托管 apps/web/dist，用 page.route 拦截所有 /api，不启动 packages/server/src/main.ts，
 * 因此不碰系统钥匙串、也不碰真实数据。运行前先构建：npm run build -w @pi-assistant/web
 *
 * 覆盖：MCP 服务删除、扩展包卸载、邮箱删除、助理电脑 purge、远程访问重试、远程入口/固定地址删除、
 *      记忆删除、技能删除 + 回滚、对话改名（校验 / Enter / Esc 不关底层）+ 删除。
 */
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

const now = Date.now();
const provider = { id: 'basic', name: '内置', capabilities: { reflect: true, mentalModels: false, temporal: false, graph: false, exportImport: true, mcpEndpoint: false } };
const hostInfo = {
	settings: { enabled: false, agents: 'all', apps: [], workspaceFiles: false, tiers: {}, defaultTier: 'bounded' },
	tiers: {},
	status: { enabled: false, tiers: {}, paused: false, daemon: { state: 'off', detail: '' }, platform: 'darwin', installed: false, version: '' },
	manifest: '',
	manifestHash: '',
	permissions: null,
	activity: { active: false, agent: null, summary: null },
};
const agents = [{ id: 'a1', name: '测试助理', avatar: '测', color: '#3b82f6', persona: '', description: '', status: 'idle', unread: 0, model: { provider: 'mock', id: 'mock' }, model_provider: 'mock', model_id: 'mock', workspace: '/tmp/ws/a1', scope: 'user' }];

const system = () => ({
	serverId: 'srv', publicKey: 'pk', pi: { version: '0.0.0', testedWith: '0.0.0', compatible: true, message: 'ok' },
	mock: true, local: true, owner: true, server: false, deviceId: 'dev', onboarded: true, modelSetupDone: true,
	defaultModel: { provider: 'mock', id: 'mock' }, credentialBackend: 'file',
	sandbox: { mode: 'workspace', preference: 'workspace', dockerAvailable: false }, entryDomain: null,
	// state=cooldown 让「重新连接」按钮出现，用来验证冷却期重试也走应用内确认框
	tunnel: { enabled: true, state: 'cooldown', mode: 'quick', url: null, failures: 1, rendezvous: { state: 'off' }, binary: null, named: {} },
	workspaceRoot: '/tmp/ws', push: { publicKey: 'pk' }, seq: 1,
});

let mcp = [{ id: 'm1', name: 'demo-mcp', enabled: true, agents: null, config: { type: 'http', url: 'https://example.com/mcp' }, status: 'ok', tools: [{ name: 't1', description: '演示工具', readOnly: true, destructive: false }], error: null, checkedAt: now }];
let pkgs = [{ id: 'p1', source: 'npm:demo-pkg', enabled: true, agents: null, status: 'installed', resources: { name: 'demo-pkg', version: '1.0.0', description: '演示扩展包', extensions: 1, skills: 1, prompts: 0 }, error: null }];
let emailItems = [{ id: 'e1', agentId: null, name: '测试邮箱', address: 'me@example.com', preset: 'qq', oauth: false, imap: { host: 'imap.qq.com', port: 993, secure: true }, smtp: { host: 'smtp.qq.com', port: 465, secure: true } }];
const emailPresets = [{ id: 'qq', label: 'QQ 邮箱' }];
let memItems = [{ id: 'm1', text: '灯灯大王喜欢简洁回答', kind: 'fact', scope: 'user', createdAt: new Date(now).toISOString(), expiresAt: null, conversationId: null, source: null }];
let skills = [{ name: 'demo-skill', description: '演示技能', builtin: false, updatedAt: now, size: 100 }];
let convs = { current: 'c1', items: [{ id: 'c1', agent_id: 'a1', title: '第一段对话', created_at: now, updated_at: now, message_count: 3, last: '你好' }] };
const desktopBase = () => ({
	settings: { enabled: true, backend: 'auto', idleMinutes: 10, mirror: '', fileMirror: '', separate: [], resources: {} },
	backend: { id: 'builtin', label: '自带运行时', ok: true },
	builtin: { id: 'builtin', label: '自带运行时', ready: true },
	dockerAvailable: false,
	image: { ref: 'ghcr.io/x/y', version: '1.0.0', digest: null, downloadBytes: 0, diskBytes: 0, custom: false },
	installed: true,
	install: { phase: 'idle', progress: 0, layersDone: 0, layersTotal: 0 },
	vm: null,
	resources: { supported: false, choice: {}, suggested: { cpus: 4, memoryGiB: 4, diskGiB: 60 }, bounds: { cpus: { min: 1, max: 8 }, memoryGiB: { min: 2, max: 16 }, diskGiB: { min: 20, max: 200 } }, applied: null, note: null },
});
let desktop = desktopBase();
let cf = { configured: true, hasToken: true, config: { hostname: 'pi.example.com', zone: 'example.com', subdomain: 'pi', deployedAt: now } };
let named = { config: { zone: 'example.com', subdomain: 'pi', hostname: 'pi.example.com', tunnelId: 't1', tunnelName: 'pi-tunnel', createdAt: now }, mode: 'named', zone: 'example.com', subdomain: 'pi', hasToken: true };

const log = { mcp: [], pkg: [], email: [], mem: [], skill: [], rollback: [], convPatch: [], convDel: [], cf: [], named: [], purge: [], retry: [] };
let failNextMcpDelete = false;
let slowNextEmailDelete = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
try {
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
	const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
	// 右侧信息面板默认打开（记忆删除在信息面板里）
	await context.addInitScript(() => localStorage.setItem('pia.layout', JSON.stringify({ sideW: 264, paneW: 340, sideCollapsed: false, info: true })));
	const page = await context.newPage();
	let nativeDialogs = 0;
	page.on('dialog', (d) => { nativeDialogs++; void d.dismiss(); });
	const pageErrors = [];
	page.on('pageerror', (e) => pageErrors.push(e.message));
	page.setDefaultTimeout(15_000);

	const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
	await page.route('**/api/**', async (route) => {
		const req = route.request();
		const p = new URL(req.url()).pathname;
		const method = req.method();
		// 全局
		if (p === '/api/system') return json(route, system());
		if (p === '/api/system/public') return json(route, {});
		if (p === '/api/agents' && method === 'GET') return json(route, agents);
		if (p === '/api/rooms') return json(route, []);
		if (p === '/api/channels') return json(route, { items: [], publicUrl: null });
		if (p === '/api/wechat') return json(route, { enabled: false, acknowledgedAt: null, agentIds: [] });
		if (p === '/api/downloads') return json(route, { items: [] });
		if (p.startsWith('/api/proactive/inbox')) return json(route, { items: [], count: 0, defaultLevel: 'normal' });
		if (p === '/api/devices') return json(route, []);
		if (p === '/api/models/providers') return json(route, { providers: [] });
		if (p === '/api/models') return json(route, []);
		if (p === '/api/host-control') return json(route, hostInfo);
		if (p.startsWith('/api/usage/summary')) return json(route, { totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unknownCalls: 0 } });
		if (p === '/api/memory/providers') return json(route, { global: 'basic', providers: [provider] });
		if (p === '/api/memory/hindsight') return json(route, { status: { state: 'ready', detail: '', pending: 0 } });
		if (p === '/api/skill-suggest') return json(route, { enabled: false });
		if (p === '/api/settings') return json(route, {});
		// agent 作用域
		if (p === '/api/agents/a1/messages') return json(route, []);
		if (p === '/api/subagents') return json(route, []);
		if (p === '/api/agents/a1/routines') return json(route, []);
		if (p === '/api/agents/a1/computer') return json(route, { separate: false, hasData: null, desktop: { enabled: true, state: 'running' } });
		if (p === '/api/agents/a1/read') return json(route, {});
		if (p === '/api/agents/a1/conversations' && method === 'GET') return json(route, convs);
		if (p === '/api/agents/a1/memory' && method === 'GET') return json(route, { provider, agentProvider: null, items: memItems });
		// 删除类（带日志，用于断言取消 0 请求）
		if (p === '/api/mcp' && method === 'GET') return json(route, mcp);
		if (p === '/api/pi-packages' && method === 'GET') return json(route, pkgs);
		if (p === '/api/email' && method === 'GET') return json(route, { items: emailItems, presets: emailPresets });
		if (p === '/api/skills' && method === 'GET') return json(route, skills);
		if (p === '/api/desktop' && method === 'GET') return json(route, desktop);
		if (p === '/api/remote/cloudflare' && method === 'GET') return json(route, cf);
		if (p === '/api/remote/named' && method === 'GET') return json(route, named);
		const m = p.match(/^\/api\/(mcp|pi-packages|email|skills|agents\/a1\/memory|conversations|remote\/cloudflare|remote\/named)\/([^/]+)$/);
		if (m) {
			const kind = m[1];
			const id = decodeURIComponent(m[2]);
			if (method === 'DELETE') {
				if (kind === 'mcp') {
					log.mcp.push(id);
					if (failNextMcpDelete) { failNextMcpDelete = false; return json(route, { error: '模拟删除失败' }, 500); }
					mcp = mcp.filter((x) => x.id !== id);
					return json(route, { ok: true });
				}
				if (kind === 'pi-packages') { log.pkg.push(id); pkgs = pkgs.filter((x) => x.id !== id); return json(route, { ok: true }); }
				if (kind === 'email') {
					log.email.push(id);
					if (slowNextEmailDelete) { slowNextEmailDelete = false; await sleep(700); }
					emailItems = emailItems.filter((x) => x.id !== id);
					return json(route, { ok: true });
				}
				if (kind === 'skills') { log.skill.push(id); skills = skills.filter((x) => x.name !== id); return json(route, { ok: true }); }
				if (kind === 'agents/a1/memory') { log.mem.push(id); memItems = memItems.filter((x) => x.id !== id); return json(route, { ok: true }); }
				if (kind === 'conversations') { log.convDel.push(id); convs = { ...convs, items: convs.items.filter((x) => x.id !== id) }; return json(route, { ok: true }); }
				if (kind === 'remote/cloudflare') { log.cf.push(id); cf = { configured: false, hasToken: false, config: null }; return json(route, { ok: true }); }
				if (kind === 'remote/named') { log.named.push(id); named = { ...named, config: null, mode: 'quick' }; return json(route, { ok: true }); }
			}
			if (method === 'PATCH' && kind === 'conversations') {
				const body = JSON.parse(req.postData() ?? '{}');
				log.convPatch.push({ id, title: body.title });
				convs = { ...convs, items: convs.items.map((x) => (x.id === id ? { ...x, title: body.title } : x)) };
				return json(route, { ok: true });
			}
			if (method === 'POST' && kind === 'skills' && /rollback$/.test(p)) {
				log.rollback.push(id);
				return json(route, { ok: true });
			}
		}
		if (p === '/api/skills/demo-skill/versions') return json(route, [{ version: 2, source: 'agent', note: null, created_at: now, diff: '' }, { version: 1, source: 'initial', note: null, created_at: now, diff: '' }]);
		if (p === '/api/skills/demo-skill' && method === 'GET') return json(route, { ...skills[0], body: '# 步骤\n1. 做一件事' });
		if (p === '/api/skills/demo-skill/rollback' && method === 'POST') { log.rollback.push('demo-skill'); return json(route, { ok: true }); }
		if (p === '/api/desktop/purge' && method === 'POST') { log.purge.push(1); desktop = { ...desktop, settings: { ...desktop.settings, enabled: false } }; return json(route, desktop); }
		if (p === '/api/desktop' && method === 'PUT') { const b = JSON.parse(req.postData() ?? '{}'); desktop = { ...desktop, settings: { ...desktop.settings, ...b } }; return json(route, desktop); }
		if (p === '/api/remote/tunnel/retry' && method === 'POST') { log.retry.push(1); return json(route, { ok: true }); }
		if (p === '/api/remote/cloudflare' && method === 'DELETE') { log.cf.push('cloudflare'); cf = { configured: false, hasToken: false, config: null }; return json(route, { ok: true }); }
		if (p === '/api/remote/named' && method === 'DELETE') { log.named.push('named'); named = { ...named, config: null, mode: 'quick' }; return json(route, { ok: true }); }
		return json(route, {});
	});

	const rows = (t) => page.getByTestId(t);
	const openSettings = async (tab, waitId) => {
		await page.goto(`${base}/?agent=a1&settings=${tab}`);
		await page.getByTestId('settings-content').waitFor();
		if (waitId) await page.getByTestId(waitId).waitFor();
	};

	// ---------------------------------------------------------------- 1) 设置 › 扩展（MCP）
	console.log('\n[1] 设置 › 扩展：删除 MCP 走应用内确认框');
	await openSettings('extensions', 'mcp-item');
	await page.getByTestId('mcp-delete-m1').click();
	await page.getByTestId('confirm-dialog').waitFor();
	assert.match(await page.getByTestId('confirm-dialog').textContent(), /demo-mcp/, '确认框应写明要删的 MCP 服务');
	await page.getByTestId('confirm-cancel').click();
	assert.equal(log.mcp.length, 0, '取消不应发出 DELETE');
	assert.equal(await page.getByTestId('mcp-item').count(), 1, '取消后 MCP 仍在');

	// 服务端失败：显示可读错误，条目保留，可重试
	failNextMcpDelete = true;
	await page.getByTestId('mcp-delete-m1').click();
	await page.getByTestId('confirm-ok').click();
	await page.getByText(/删除失败.*模拟删除失败/).waitFor();
	assert.equal(await page.getByTestId('mcp-item').count(), 1, '删除失败时 MCP 保留');
	assert.deepEqual(log.mcp, ['m1'], '失败前已发一次 DELETE');
	log.mcp.length = 0;

	await page.getByTestId('mcp-delete-m1').click();
	await page.getByTestId('confirm-ok').click();
	await page.getByText('还没有 MCP 服务').waitFor();
	assert.deepEqual(log.mcp, ['m1'], '确认一次只删目标 MCP');
	assert.equal(await page.getByTestId('mcp-item').count(), 0, 'MCP 已移除');

	// ---------------------------------------------------------------- 2) 设置 › 扩展（扩展包）
	console.log('\n[2] 设置 › 扩展：卸载扩展包走应用内确认框');
	await page.getByTestId('package-uninstall-p1').click();
	await page.getByTestId('confirm-dialog').waitFor();
	assert.match(await page.getByTestId('confirm-dialog').textContent(), /demo-pkg/, '确认框应写明要卸载的扩展包');
	await page.getByTestId('confirm-cancel').click();
	assert.equal(log.pkg.length, 0, '取消不应发出卸载');
	await page.getByTestId('package-uninstall-p1').click();
	await page.getByTestId('confirm-ok').click();
	await page.waitForFunction(() => !document.querySelector('[data-testid=package-item]'));
	assert.deepEqual(log.pkg, ['p1'], '确认一次只卸载目标扩展包');

	// ---------------------------------------------------------------- 3) 设置 › 邮箱
	console.log('\n[3] 设置 › 邮箱：删除邮箱走应用内确认框');
	await openSettings('email', 'email-account');
	await page.getByTestId('email-delete-e1').click();
	await page.getByTestId('confirm-dialog').waitFor();
	assert.match(await page.getByTestId('confirm-dialog').textContent(), /me@example\.com/, '确认框应写明邮箱地址');
	assert.match(await page.getByTestId('confirm-dialog').textContent(), /邮件本身不会被动/, '确认框应说明风险范围');
	await page.getByTestId('confirm-cancel').click();
	assert.equal(log.email.length, 0, '取消不应发出删除');
	// 慢响应 + 双击：只发一次 DELETE，且删除中按钮禁用
	slowNextEmailDelete = true;
	await page.getByTestId('email-delete-e1').click();
	await page.getByTestId('confirm-ok').dblclick();
	await page.waitForTimeout(150);
	assert.ok(await page.getByTestId('email-delete-e1').isDisabled(), '删除进行中按钮应禁用');
	await page.waitForTimeout(900);
	assert.deepEqual(log.email, ['e1'], '慢删除期间只发一次 DELETE');

	// ---------------------------------------------------------------- 4) 设置 › 助理电脑（purge）
	console.log('\n[4] 设置 › 助理电脑：删除虚拟机/镜像走应用内确认框并写明风险');
	await openSettings('computer', 'desktop-enabled');
	await page.getByTestId('desktop-enabled').click();
	await page.getByTestId('desktop-off-actions').waitFor();
	await page.getByTestId('desktop-purge').click();
	await page.getByTestId('confirm-dialog').waitFor();
	const purgeText = await page.getByTestId('confirm-dialog').textContent();
	assert.match(purgeText, /登录状态/, '确认框应写明会清掉登录状态');
	assert.match(purgeText, /重新下载/, '确认框应说明下次要重新下载');
	await page.getByTestId('confirm-cancel').click();
	assert.equal(log.purge.length, 0, '取消不应发出 purge');
	await page.getByTestId('desktop-purge').click();
	await page.getByTestId('confirm-ok').click();
	await page.waitForTimeout(200);
	assert.deepEqual(log.purge, [1], '确认一次只发一次 purge');

	// ---------------------------------------------------------------- 5) 设置 › 远程访问（冷却期重试）
	console.log('\n[5] 设置 › 远程访问：冷却期重试也走应用内确认框');
	await openSettings('remote', 'settings-content');
	await page.getByRole('button', { name: '重新连接' }).click();
	await page.getByTestId('confirm-dialog').waitFor();
	assert.match(await page.getByTestId('confirm-dialog').textContent(), /限流冷却期/, '确认框应说明正在冷却');
	await page.getByTestId('confirm-cancel').click();
	assert.equal(log.retry.length, 0, '取消不应重试');
	await page.getByRole('button', { name: '重新连接' }).click();
	await page.getByTestId('confirm-ok').click();
	await page.waitForTimeout(150);
	assert.deepEqual(log.retry, [1], '确认一次才重试');

	// ---------------------------------------------------------------- 6) 设置 › 固定地址 / 入口
	console.log('\n[6] 设置 › 固定地址 / 入口：删除走应用内确认框');
	await openSettings('entry', 'named-tunnel');
	await page.getByTestId('named-remove').click();
	await page.getByTestId('confirm-dialog').waitFor();
	assert.match(await page.getByTestId('confirm-dialog').textContent(), /DNS 记录/, '固定地址确认框应写明会删 DNS 记录');
	await page.getByTestId('confirm-cancel').click();
	assert.equal(log.named.length, 0, '取消不应删除固定地址');
	await page.getByTestId('named-remove').click();
	await page.getByTestId('confirm-ok').click();
	await page.waitForTimeout(150);
	assert.deepEqual(log.named, ['named'], '确认一次才删固定地址');

	await page.getByTestId('entry-remove').click();
	await page.getByTestId('confirm-dialog').waitFor();
	assert.match(await page.getByTestId('confirm-dialog').textContent(), /Token 也会清除/, '远程入口确认框应写明 Token 会被清除');
	await page.getByTestId('confirm-ok').click();
	await page.waitForTimeout(150);
	assert.deepEqual(log.cf, ['cloudflare'], '确认一次才删远程入口');

	// ---------------------------------------------------------------- 7) 设置 › 技能库（回滚 + 删除）
	console.log('\n[7] 设置 › 技能库：回滚 / 删除走应用内确认框');
	await openSettings('skills', 'skills-tab');
	await page.getByTestId('skill-item-demo-skill').click();
	await page.getByTestId('skill-versions').waitFor();
	await page.getByTestId('skill-rollback-1').click();
	await page.getByTestId('confirm-dialog').waitFor();
	assert.match(await page.getByTestId('confirm-dialog').textContent(), /回滚到 v1/, '回滚确认框应写明版本');
	await page.getByTestId('confirm-cancel').click();
	assert.equal(log.rollback.length, 0, '取消不应回滚');
	await page.getByTestId('skill-rollback-1').click();
	await page.getByTestId('confirm-ok').click();
	await page.waitForTimeout(150);
	assert.deepEqual(log.rollback, ['demo-skill'], '确认一次才回滚');

	await page.getByTestId('skill-delete').click();
	await page.getByTestId('confirm-dialog').waitFor();
	assert.match(await page.getByTestId('confirm-dialog').textContent(), /demo-skill/, '删除技能确认框应写明技能名');
	await page.getByTestId('confirm-cancel').click();
	assert.equal(log.skill.length, 0, '取消不应删除技能');
	await page.getByTestId('skill-delete').click();
	await page.getByTestId('confirm-ok').click();
	await page.getByTestId('skills-tab').waitFor();
	assert.deepEqual(log.skill, ['demo-skill'], '确认一次才删除技能');

	// ---------------------------------------------------------------- 8) 信息面板 › 记忆
	console.log('\n[8] 信息面板 › 记忆：删除记忆走应用内确认框');
	await page.goto(`${base}/?agent=a1`);
	await page.getByTestId('info-tabs').waitFor();
	const memTab = page.locator('[data-testid=info-tabs] [data-itab=memory]');
	if (await memTab.count()) await memTab.click();
	else { await page.getByTestId('info-tabs-more').click(); await page.locator('[data-testid=info-tabs-menu] [data-itab=memory]').click(); }
	await page.getByTestId('memory-tab').waitFor();
	await page.getByTestId('memory-delete-m1').click();
	await page.getByTestId('confirm-dialog').waitFor();
	assert.match(await page.getByTestId('confirm-dialog').textContent(), /删除这条记忆/, '记忆确认框标题');
	await page.getByTestId('confirm-cancel').click();
	assert.equal(log.mem.length, 0, '取消不应删除记忆');
	await page.getByTestId('memory-delete-m1').click();
	await page.getByTestId('confirm-ok').click();
	await page.waitForTimeout(150);
	assert.deepEqual(log.mem, ['m1'], '确认一次才删除记忆');

	// ---------------------------------------------------------------- 9) 对话：改名 + 删除
	console.log('\n[9] 对话菜单：改名走应用内 Modal（校验 / Enter / Esc 不关底层），删除走确认框');
	await page.goto(`${base}/?agent=a1`);
	await page.getByTestId('conv-menu').waitFor();
	await page.getByTestId('conv-menu').click();
	await page.locator('[role=menu]').waitFor();
	await page.getByTestId('conv-rename-c1').click();
	await page.getByTestId('conv-rename-dialog').waitFor();
	// 空名被拦、不发请求
	await page.getByTestId('conv-rename-input').fill('');
	await page.getByTestId('conv-rename-input').press('Enter');
	await page.getByTestId('conv-rename-error').waitFor();
	assert.match(await page.getByTestId('conv-rename-error').textContent(), /不能为空/, '空名应提示');
	assert.equal(log.convPatch.length, 0, '空名不应发 PATCH');
	// Esc 只关改名框，不关底层对话菜单
	await page.keyboard.press('Escape');
	await page.waitForFunction(() => !document.querySelector('[data-testid=conv-rename-dialog]'));
	assert.ok(await page.locator('[role=menu]').isVisible(), 'Esc 关闭改名框后底层对话菜单仍在');
	// 正常改名：Enter 提交
	await page.getByTestId('conv-rename-c1').click();
	await page.getByTestId('conv-rename-input').fill('改名后的对话');
	await page.getByTestId('conv-rename-input').press('Enter');
	await page.waitForFunction(() => !document.querySelector('[data-testid=conv-rename-dialog]'));
	assert.deepEqual(log.convPatch, [{ id: 'c1', title: '改名后的对话' }], 'Enter 提交改名');
	await page.getByText('改名后的对话').first().waitFor();
	// 删除：取消 0 请求；确认才删
	await page.getByTestId('conv-delete-c1').click();
	await page.getByTestId('confirm-dialog').waitFor();
	assert.match(await page.getByTestId('confirm-dialog').textContent(), /无法恢复/, '删除对话确认框应说明不可恢复');
	await page.getByTestId('confirm-cancel').click();
	assert.equal(log.convDel.length, 0, '取消不应删除对话');
	await page.getByTestId('conv-delete-c1').click();
	await page.getByTestId('confirm-ok').click();
	await page.waitForTimeout(200);
	assert.deepEqual(log.convDel, ['c1'], '确认一次才删除对话');

	// ---------------------------------------------------------------- 10) 390 窄屏 + Esc 不关底层
	console.log('\n[10] 390 窄屏：确认框在视口内，Esc 只关确认框、不关设置弹窗');
	await page.setViewportSize({ width: 390, height: 780 });
	emailItems = [{ id: 'e1', agentId: null, name: '测试邮箱', address: 'me@example.com', preset: 'qq', oauth: false, imap: { host: 'imap.qq.com', port: 993, secure: true }, smtp: { host: 'smtp.qq.com', port: 465, secure: true } }];
	await openSettings('email', 'email-account');
	await page.getByTestId('email-delete-e1').click();
	await page.getByTestId('confirm-dialog').waitFor();
	const box = await page.getByTestId('confirm-dialog').boundingBox();
	assert.ok(box && box.x >= 0 && box.x + box.width <= 390, '390 宽下确认框不横向溢出');
	await page.keyboard.press('Escape');
	await page.waitForFunction(() => !document.querySelector('[data-testid=confirm-dialog]'));
	assert.ok(await page.getByTestId('settings-content').isVisible(), 'Esc 关闭确认框后设置弹窗仍在（不关底层）');

	assert.equal(nativeDialogs, 0, '全程不得调用原生 confirm/alert/prompt');
	assert.deepEqual(pageErrors, [], '页面不应出现未捕获错误');
	console.log('\n通过：MCP / 扩展包 / 邮箱 / 助理电脑 / 远程重试 / 远程入口与固定地址 / 记忆 / 技能回滚与删除 / 对话改名与删除全部走应用内对话框；取消 0 请求、失败可见、删除中防双击、Esc 只关当前层、390 可用、无原生 dialog。');
} finally {
	await browser?.close();
	web.close();
}
