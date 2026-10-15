import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

// 统一模型服务 UI 原型链路测试（纯前端 fixture）：
// 静态托管 apps/web/dist，page.route 拦截所有 /api，不启动 packages/server/src/main.ts，
// 因此不碰系统钥匙串、不碰真实用户配置、不跑真实 API 收费、不装模型、不操作电脑。
// 覆盖：服务卡片 / 能力标签（含「未确认」）/ 能力纠正 / 添加服务 / 本地 Laya health 与卸载确认 /
//       实际操作测试（availability、尚未运行、真实执行未验证、结果 advisory）/ Esc 关弹窗 / 390 宽 / 无原生 dialog。
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
		id: 'openai', name: 'OpenAI', kind: 'builtin', configured: true, protocols: ['openai-completions'],
		models: [
			{ provider: 'openai', id: 'gpt-4o', name: 'GPT-4o', type: 'chat', capabilities: ['chat', 'vision'], protocol: 'openai-completions', confirmed: true, inferred: [], source: 'pi-catalog', configured: true },
			{ provider: 'openai', id: 'gpt-image-1', name: 'gpt-image-1', type: 'image', capabilities: ['image'], protocol: 'openai', confirmed: true, inferred: [], source: 'pi-catalog', configured: true, imageAdapter: { kind: 'openai', baseUrl: 'https://api.openai.com/v1', edit: true }, costNote: '约 $0.04/张' },
		],
	},
	{
		id: 'custom-relay', name: '我的中转站', kind: 'custom', baseUrl: 'https://relay.example.com/v1', configured: true, protocols: ['openai-completions'],
		models: [
			{ provider: 'custom-relay', id: 'deepseek-v3', name: 'deepseek-v3', type: 'chat', capabilities: ['chat'], protocol: 'openai-completions', confirmed: true, inferred: [], source: 'custom', configured: true },
			{ provider: 'custom-relay', id: 'mystery-model', name: 'mystery-model', type: 'chat', capabilities: ['chat', 'vision'], protocol: 'openai-completions', confirmed: false, inferred: ['vision'], source: 'custom', configured: true },
		],
	},
	{
		id: 'laya-local', name: '本地 Laya', kind: 'local', configured: true, protocols: ['llama-cpp-classify'],
		models: [{ provider: 'laya-local', id: 'laya-fast', name: 'laya-fast', type: 'classifier', capabilities: ['classifier'], protocol: 'llama-cpp-classify', confirmed: true, inferred: [], source: 'custom', configured: true }],
		local: localOffline,
	},
];
let providers = fixtures();
let capPuts = [];
const availability = { cuaReady: true, modelReady: true, fixtureReady: true, reasons: [] };
const benchmarkRun = (status) => ({
	id: 'b1', status, provider: 'laya-local', model: 'laya-fast', modelVersion: 'unknown',
	target: { prefix: 'computer', fixtureId: 'fix-1' }, createdAt: new Date().toISOString(),
	warmup: 2, samples: 24, coldStartMs: 1320, p50Ms: 860, p95Ms: 1420, p95Approx: false,
	timeouts: 0, errors: 1, successRatio: 0.92, actions: 30, retries: 2, fallbackCount: 1, abstains: 1,
	correctness: 0.9, correctTrials: 22, note: '样本 24 条；推理时延仅诊断子项，不代表整个 CUA 速度。',
	advisory: { verdict: 'slow', recommended: true, message: 'p50 略高于目标预算，仍可继续使用。', reason: 'p50 > budget' },
});

let browser;
try {
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
	const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
	await context.addInitScript(() => {
		for (const k of ['confirm', 'alert', 'prompt']) {
			window[k] = () => {
				window.__nativeDialogs = (window.__nativeDialogs ?? 0) + 1;
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
		// 统一模型服务（registry agent 契约）
		if (path === '/api/models/registry' && method === 'GET') return json(route, { providers });
		if (/^\/api\/models\/registry\/[^/]+\/models\/[^/]+\/capabilities$/.test(path) && method === 'PUT') {
			capPuts.push({ path, body: req.postDataJSON() });
			return json(route, { ok: true });
		}
		if (/^\/api\/model-services\/[^/]+\/local$/.test(path) && method === 'DELETE') {
			const id = path.split('/')[3];
			providers = providers.map((p) => (p.id === id ? { ...p, configured: false, local: { ...localOffline, installed: false, ready: 'not_installed', offlineReady: false, health: undefined } } : p));
			return json(route, providers.find((p) => p.id === id).local);
		}
		// 实际操作测试（benchmark agent 契约）
		if (path === '/api/fast-computer/benchmark' && method === 'GET') return json(route, { availability, runs: [] });
		if (path === '/api/fast-computer/benchmark' && method === 'POST') return json(route, { ok: true, run: benchmarkRun('running') });
		if (path === '/api/fast-computer/benchmark/b1' && method === 'GET') return json(route, benchmarkRun('done'));
		if (path === '/api/fast-computer/benchmark/b1/cancel') return json(route, { ok: true });
		return json(route, {});
	});

	await page.goto(`${base}/?settings=models`);
	await page.getByTestId('settings-dialog').waitFor();
	const panel = page.getByTestId('model-services-panel');
	await panel.waitFor();
	const cards = () => page.locator('[data-testid=service-card]');
	assert.equal(await cards().count(), 3, '应显示 3 个模型服务卡片');

	// 1) 能力标签：推断出来的能力标「未确认」
	const relay = page.locator('[data-testid=service-card][data-service=custom-relay]');
	await relay.getByTestId('service-toggle-custom-relay').click();
	const mystery = page.locator('[data-testid=service-model][data-model=mystery-model]');
	assert.match(await mystery.getByTestId('model-caps').textContent(), /识图？/, '推断能力应标「未确认」');

	// 2) 能力纠正：给 mystery-model 加「生图」，PUT 到 registry，标签更新
	await mystery.getByTestId('model-capability-toggle').click();
	await mystery.getByTestId('cap-image').check();
	await mystery.getByTestId('cap-save').click();
	await page.waitForTimeout(80);
	assert.equal(capPuts.length, 1, '应发出一次能力纠正 PUT');
	assert.ok(capPuts[0].body.capabilities.includes('image'), '纠正内容应含 image');
	assert.match(await mystery.getByTestId('model-caps').textContent(), /生图/, '纠正后应显示生图标签');

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

	// 5) 实际操作测试：先显示「尚未运行 / 真实执行未验证」，再选电脑 + 确认 + 跑出结果
	providers = fixtures();
	await page.reload();
	await page.getByTestId('settings-dialog').waitFor();
	const laya2 = page.locator('[data-testid=service-card][data-service=laya-local]');
	await laya2.getByTestId('service-toggle-laya-local').click();
	await laya2.getByTestId('benchmark-open-laya-fast').click();
	await page.getByTestId('actual-task-test').waitFor();
	assert.match(await page.getByTestId('actual-task-test').textContent(), /专用隔离测试窗口/, '需说明专用测试窗口');
	assert.match(await page.getByTestId('actual-task-preflight').textContent(), /前置条件/, '需说明前置条件校验');
	assert.match(await page.getByTestId('benchmark-unverified-note').textContent(), /不等于 CUA 成功/, '需声明真实执行未验证');
	assert.match(await page.getByTestId('actual-task-verdict').textContent(), /尚未运行/, '未跑过时显示尚未运行');
	await page.getByTestId('actual-task-target').click();
	await page.getByRole('option', { name: /助理电脑/ }).click();
	await page.getByTestId('actual-task-ack').check();
	await page.getByTestId('actual-task-start').click();
	await page.waitForFunction(() => document.querySelector('[data-testid=actual-task-verdict]')?.textContent?.includes('偏慢'), null, { timeout: 5000 });
	assert.match(await page.getByTestId('actual-task-verdict').textContent(), /偏慢，仍可继续用/, '结果应给 advisory 建议');
	assert.match(await page.getByTestId('actual-task-accuracy-note').textContent(), /不代表整个 CUA 速度/, '需声明不等于整个 CUA 速度');
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

	const nativeDialogs = await page.evaluate(() => window.__nativeDialogs ?? 0);
	assert.equal(nativeDialogs, 0, '不得调用原生 confirm/alert/prompt');
	console.log('通过：统一模型服务原型（能力标签/纠正、添加服务、Laya health+卸载确认、实际操作测试 availability/未验证/advisory、Esc、390 宽、无原生 dialog）。');
} finally {
	await browser?.close();
	web.close();
}
