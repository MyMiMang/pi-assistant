import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

// 统一模型服务 UI 原型链路测试（纯前端 fixture）：
// 静态托管 apps/web/dist，page.route 拦截所有 /api，不启动 packages/server/src/main.ts，
// 因此不碰系统钥匙串、不碰真实用户配置、不跑真实 API 收费、不装模型。
// 覆盖：服务卡片 / 能力标签（含未知灰态）/ 能力纠正 / 添加服务 / 本地 Laya health 与卸载确认 /
//       实际操作测试（选电脑、确认、结果建议）/ Esc 关弹窗 / 390 宽不溢出 / 无原生 dialog。
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

const localOffline = {
	installed: true, ready: 'offline_ready', offlineReady: true,
	phases: { env: { state: 'done', percent: 100 }, weights: { state: 'done', percent: 100 }, verify: { state: 'done', percent: 100 } },
	health: { status: 'ok', checkedAt: Date.now(), cpu: { label: 'Apple M2 Pro', cores: 12, baseline: true }, gpu: { vendor: 'apple', backend: 'mps', available: true, label: 'Apple MPS', source: 'probe' } },
	platform: { os: 'macOS', arch: 'arm64', support: 'baseline', note: '' },
};

const fixtures = () => [
	{
		id: 'openai', name: 'OpenAI', kind: 'official', configured: true,
		models: [
			{ id: 'gpt-4o', name: 'GPT-4o', capabilities: [{ capability: 'chat', source: 'catalog', confidence: 'high' }, { capability: 'vision', source: 'catalog', confidence: 'high' }] },
			{ id: 'gpt-image-1', capabilities: [{ capability: 'image', source: 'catalog', confidence: 'high' }] },
		],
		counts: { chat: 1, vision: 1, image: 1, classifier: 0 },
	},
	{
		id: 'custom-relay', name: '我的中转站', kind: 'custom', baseUrl: 'https://relay.example.com/v1', configured: true,
		models: [
			{ id: 'deepseek-v3', capabilities: [{ capability: 'chat', source: 'metadata', confidence: 'high' }] },
			{ id: 'mystery-model', capabilities: [{ capability: 'chat', source: 'unknown', confidence: 'low' }] },
		],
		counts: { chat: 2, vision: 0, image: 0, classifier: 0 },
	},
	{
		id: 'laya-local', name: '本地 Laya', kind: 'local', configured: true,
		models: [{ id: 'laya-fast', capabilities: [{ capability: 'classifier', source: 'catalog', confidence: 'medium' }] }],
		counts: { chat: 0, vision: 0, image: 0, classifier: 1 }, local: localOffline,
	},
];
let services = fixtures();
let capPuts = [];
let nativeDialogs = 0;

let browser;
try {
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
	const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
	await context.addInitScript(() => {
		for (const k of ['confirm', 'alert', 'prompt']) {
			window[k] = () => {
				(window).__nativeDialogs = ((window).__nativeDialogs ?? 0) + 1;
				return k === 'confirm' ? false : null;
			};
		}
	});
	const page = await context.newPage();
	const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
	await page.route('**/api/**', async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		const method = req.method();
		if (path === '/api/system') return json(route, system);
		if (path === '/api/agents') return json(route, []);
		if (path === '/api/rooms') return json(route, []);
		if (path === '/api/downloads') return json(route, { items: [] });
		if (path.startsWith('/api/proactive/inbox')) return json(route, { items: [], count: 0, defaultLevel: 'normal' });
		// 模型页依赖的既有接口：返回空壳，保证旧区块不崩
		if (path === '/api/models/providers') return json(route, []);
		if (path === '/api/models/custom') return json(route, { providers: [], apis: [], classifierProtocols: [] });
		if (path === '/api/models/vision') return json(route, { setting: null, current: null, source: 'none', candidates: [] });
		if (path === '/api/model-strengths') return json(route, { labels: [], models: [] });
		if (path === '/api/image-models') return json(route, { kinds: [], providers: [], models: [], default: null, reusable: [] });
		if (path === '/api/fast-computer/settings') return json(route, { settings: { enabled: false, kind: 'systemone', provider: '', id: '' }, models: [], classifierModels: [] });
		if (path === '/api/subagents/settings') return json(route, { settings: { maxConcurrent: 10, maxMinutes: 10 }, models: [] });
		// 统一模型服务（本任务）
		if (path === '/api/model-services' && method === 'GET') return json(route, { services });
		if (/^\/api\/model-services\/[^/]+\/models\/[^/]+\/capabilities$/.test(path) && method === 'PUT') {
			capPuts.push({ path, body: req.postDataJSON() });
			return json(route, { ok: true });
		}
		if (/^\/api\/model-services\/[^/]+\/local$/.test(path) && method === 'DELETE') {
			const id = path.split('/')[3];
			services = services.map((s) => (s.id === id ? { ...s, configured: false, local: { ...localOffline, installed: false, ready: 'not_installed', offlineReady: false, health: undefined } } : s));
			return json(route, services.find((s) => s.id === id).local);
		}
		if (path === '/api/actual-task-test/start' && method === 'POST') return json(route, { taskId: 't1' });
		if (path === '/api/actual-task-test/t1') return json(route, {
			kind: 'controlled-cua-task', target: 'assistant', status: 'done',
			steps: ['observe', 'candidate', 'classify', 'fresh-click', 'verify'].map((id) => ({ id, label: id, state: 'done' })),
			success: true, totalMs: 8420, errors: [], retries: 1, mainFallback: 0,
			preflight: { permissionsOk: true, vmReady: true, confirmedByUser: true },
			samples: 3,
			verdict: { level: 'caution', advisory: true, reason: '成功率尚可，但样本只有 3 次。', accuracyNote: '样本有限，不代表普遍准确；结论仅针对本次受控任务。' },
			apiLatency: { p50: 640, p95: 1180 },
		});
		return json(route, {});
	});

	await page.goto(`${base}/?settings=models`);
	await page.getByTestId('settings-dialog').waitFor();
	const panel = page.getByTestId('model-services-panel');
	await panel.waitFor();
	const cards = () => page.locator('[data-testid=service-card]');
	assert.equal(await cards().count(), 3, '应显示 3 个模型服务卡片');

	// 1) 能力标签：未知能力显示灰态「？」
	const relay = page.locator('[data-testid=service-card][data-service=custom-relay]');
	await relay.getByTestId('service-toggle-custom-relay').click();
	const mystery = page.locator('[data-testid=service-model][data-model=mystery-model]');
	assert.match(await mystery.getByTestId('model-caps').textContent(), /对话？/, '未知能力应带「？」灰态');

	// 2) 能力纠正：给 mystery-model 加「识图」，PUT 到接口，标签更新为手动来源
	await mystery.getByTestId('model-capability-toggle').click();
	await mystery.getByTestId('cap-vision').check();
	await mystery.getByTestId('cap-save').click();
	await page.waitForTimeout(80);
	assert.equal(capPuts.length, 1, '应发出一次能力纠正 PUT');
	assert.deepEqual(capPuts[0].body.capabilities.sort(), ['chat', 'vision'], '纠正内容应为 chat+vision');
	assert.match(await mystery.getByTestId('model-caps').textContent(), /识图/, '纠正后应显示识图标签');

	// 3) 添加服务：Select 选类型（非原生 select）+ 填地址 Key + 添加
	await page.getByTestId('add-service-open').click();
	await page.getByTestId('add-service').waitFor();
	await page.getByTestId('add-service-kind').click();
	await page.getByRole('option', { name: /自定义/ }).click();
	await page.getByTestId('add-service-name').fill('新中转');
	await page.getByTestId('add-service-baseurl').fill('https://new.example.com/v1');
	await page.getByTestId('add-service-key').fill('sk-test-not-real');
	await page.getByTestId('add-service-submit').click();
	await page.waitForTimeout(80);
	assert.equal(await cards().count(), 4, '添加后应有 4 个服务卡片');

	// 4) 本地 Laya：health 用实际探测标签；卸载走自绘确认框（不是原生 confirm）
	const laya = page.locator('[data-testid=service-card][data-service=laya-local]');
	await laya.getByTestId('service-toggle-laya-local').click();
	await laya.getByTestId('local-health').waitFor();
	assert.match(await laya.getByTestId('local-gpu').textContent(), /Apple MPS/, 'GPU 标签应来自实际探测');
	assert.equal(await laya.getByTestId('local-gpu').getAttribute('data-gpu-available'), 'true');
	await laya.getByTestId('local-uninstall').click();
	await page.getByTestId('confirm-dialog').waitFor();
	assert.match(await page.getByTestId('confirm-dialog').textContent(), /卸载本地 Laya/, '卸载需自绘确认框');
	await page.getByTestId('confirm-cancel').click();
	await page.waitForTimeout(60);
	assert.equal(await laya.getByTestId('local-ready').textContent(), '离线可用', '取消卸载后状态不变');
	await laya.getByTestId('local-uninstall').click();
	await page.getByTestId('confirm-ok').click();
	await page.waitForTimeout(80);
	assert.equal(await laya.getByTestId('local-ready').textContent(), '未安装', '确认后卸载');

	// 5) 实际操作测试：选测试电脑 + 确认 + 结果建议（使用/谨慎/不建议）但仍可继续用
	await laya.getByTestId('local-install').waitFor();
	// 先恢复为可用，再从卡片进测试
	services = fixtures();
	await page.reload();
	await page.getByTestId('settings-dialog').waitFor();
	const laya2 = page.locator('[data-testid=service-card][data-service=laya-local]');
	await laya2.getByTestId('service-toggle-laya-local').click();
	await laya2.getByTestId('actual-task-open-laya-local').click();
	await page.getByTestId('actual-task-test').waitFor();
	assert.match(await page.getByTestId('actual-task-test').textContent(), /专用测试窗口/, '需说明会打开专用测试窗口');
	assert.match(await page.getByTestId('actual-task-test').textContent(), /前置条件/, '需说明前置条件校验');
	await page.getByTestId('actual-task-target').click();
	await page.getByRole('option', { name: /助理电脑/ }).click();
	await page.getByTestId('actual-task-ack').check();
	await page.getByTestId('actual-task-start').click();
	await page.getByTestId('actual-task-result').waitFor();
	assert.match(await page.getByTestId('actual-task-verdict').textContent(), /谨慎使用/, '报告应给建议等级');
	assert.match(await page.getByTestId('actual-task-accuracy-note').textContent(), /样本有限/, '需声明样本有限不代表普遍准确');
	await page.getByTestId('actual-task-use-anyway').click();

	// 6) Esc 关弹窗（键盘可达）
	await page.getByTestId('add-service-open').click();
	await page.getByTestId('add-service').waitFor();
	await page.keyboard.press('Escape');
	await page.waitForTimeout(80);
	assert.equal(await page.getByTestId('add-service').count(), 0, 'Esc 应关闭添加服务弹窗');

	// 7) 390 宽不横向溢出
	await page.setViewportSize({ width: 390, height: 780 });
	await page.reload();
	await page.getByTestId('settings-dialog').waitFor();
	await panel.waitFor();
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	assert.ok(overflow <= 1, `390 宽不应横向溢出（实际 ${overflow}px）`);

	nativeDialogs = await page.evaluate(() => (window).__nativeDialogs ?? 0);
	assert.equal(nativeDialogs, 0, '不得调用原生 confirm/alert/prompt');
	console.log('通过：统一模型服务原型（能力标签/纠正、添加服务、Laya health+卸载确认、实际操作测试、Esc、390 宽、无原生 dialog）。');
} finally {
	await browser?.close();
	web.close();
}
