import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

// 统一模型服务 UI 原型链路测试（纯前端 fixture）：
// 静态托管 apps/web/dist，page.route 拦截所有 /api，不启动 packages/server/src/main.ts，
// 因此不碰系统钥匙串、不碰真实用户配置、不跑真实 API 收费、不装模型、不操作电脑。
// 覆盖：服务卡片 / 能力标签（含「未确认」）/ 能力纠正 / 添加服务 / 本地 Laya 管理卡（安装态·运行态·health·未就绪不删配置·卸载确认）/
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

const layaStatus = (over = {}) => ({
	platform: { key: 'darwin-arm64', os: 'macOS', arch: 'arm64', accelerator: 'mps', support: 'supported', torchBackend: 'default', pins: [], reason: '' },
	install: { state: 'installed', phase: 'done', received: 0, total: null, error: null, installedAt: Date.now() },
	runtime: { state: 'running', pid: 4242, port: 51789, host: '127.0.0.1' },
	health: { ok: true, device: 'mps', checkpointDevices: { multilingual: 'mps' }, cpuFallbacks: { count: 0, lastReason: null }, revisions: { laya: 'abc1234' }, loaded: ['multilingual'] },
	registered: { provider: 'local-laya', modelId: 'multilingual', protocol: 'typesafe-system-one' },
	source: { project: 'Laya', repoUrl: 'https://example.invalid/laya', weightsOrg: 'Laya', codeLicense: 'Apache-2.0', weightsLicense: 'see repo', version: 'v1', reviewedRevisions: {} },
	...over,
});
let laya = layaStatus();

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
	// registry 里本地 Laya 会作为 local-laya 出现；UI 用管理卡统一展示，不重复成卡片
	{ id: 'local-laya', name: '本地 Laya', kind: 'local', configured: true, protocols: ['typesafe-system-one'], models: [{ provider: 'local-laya', id: 'multilingual', name: 'multilingual', type: 'classifier', capabilities: ['classifier'], protocol: 'typesafe-system-one', confirmed: true, inferred: [], source: 'pi-catalog', configured: true }] },
];
let providers = fixtures();
let capPuts = [];
let benchPosts = [];
const availability = { cuaReady: true, modelReady: true, fixtureReady: true, reasons: [] };
const benchmarkRun = (status) => ({
	id: 'b1', status, provider: 'local-laya', model: 'multilingual', modelVersion: 'unknown',
	target: { prefix: 'computer', fixtureId: 'fix-1' }, startedAt: new Date(Date.now() - 9000).toISOString(), finishedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
	warmup: 2, samples: 24, coldStartMs: 1320, p50Ms: 860, p95Ms: 1420, p95Approx: false,
	timeouts: 0, errors: 1, successRatio: 0.92, actions: 30, retries: 2, fallbackCount: 0, abstains: 1,
	correctness: 0.9, correctTrials: 22, note: '样本 24 条；p50 仅为步骤诊断，不代表整个 CUA 速度。',
	advisory: { verdict: 'slow', recommended: true, message: 'p50 略高于目标预算，仍可继续使用。', reason: 'p50 > budget' },
	reason: null,
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
		// 本地 Laya（local-laya-runtime 冻结契约）
		if (path === '/api/local-models/laya/status') return json(route, laya);
		if (path === '/api/local-models/laya/stop') {
			laya = layaStatus({ runtime: { state: 'stopped', pid: null, port: null, host: '127.0.0.1' }, registered: null, health: null });
			return json(route, { ok: true, status: laya });
		}
		if (path === '/api/local-models/laya/start') {
			laya = layaStatus();
			return json(route, { ok: true, status: laya });
		}
		if (path === '/api/local-models/laya/install') {
			laya = layaStatus({ install: { state: 'installing', phase: 'weights', received: 40, total: 100, error: null, installedAt: null }, runtime: { state: 'stopped', pid: null, port: null, host: '127.0.0.1' }, registered: null, health: null });
			return json(route, { ok: true, status: laya });
		}
		if (path === '/api/local-models/laya/cancel' || path === '/api/local-models/laya/update') return json(route, { ok: true, status: laya });
		if (path === '/api/local-models/laya' && method === 'DELETE') {
			laya = layaStatus({ install: { state: 'not_installed', phase: 'idle', received: 0, total: null, error: null, installedAt: null }, runtime: { state: 'stopped', pid: null, port: null, host: '127.0.0.1' }, registered: null, health: null });
			return json(route, { ok: true, status: laya });
		}
		// 实际操作测试（benchmark agent 契约）
		if (path === '/api/fast-computer/benchmark' && method === 'GET') return json(route, { availability, runs: [] });
		if (path === '/api/fast-computer/benchmark' && method === 'POST') { benchPosts.push(req.postDataJSON()); return json(route, { ok: true, run: benchmarkRun('running') }); }
		if (path === '/api/fast-computer/benchmark/b1' && method === 'GET') return json(route, benchmarkRun('done'));
		if (path === '/api/fast-computer/benchmark/b1/cancel') return json(route, { ok: true });
		return json(route, {});
	});

	await page.goto(`${base}/?settings=models`);
	await page.getByTestId('settings-dialog').waitFor();
	const panel = page.getByTestId('model-services-panel');
	await panel.waitFor();
	const cards = () => page.locator('[data-testid=service-card]');
	assert.equal(await cards().count(), 2, 'registry 里 2 个服务卡片（local-laya 由管理卡展示，不重复）');
	await page.getByTestId('local-laya-card').waitFor();
	const SHOT = process.env.SHOT_DIR;
	if (SHOT) await page.locator('[data-testid=model-services]').screenshot({ path: `${SHOT}/1-services-desktop.png` });

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
	assert.equal(await cards().count(), 3, '添加后应有 3 个服务卡片');

	// 4) 本地 Laya 管理卡：运行态 + health 实际设备 + 已注册模型
	const layaCard = page.getByTestId('local-laya-card');
	assert.equal(await layaCard.getAttribute('data-source'), 'local');
	assert.match(await page.getByTestId('laya-install-state').textContent(), /已安装/);
	assert.match(await page.getByTestId('laya-runtime-state').textContent(), /运行中/);
	assert.match(await page.getByTestId('laya-device').textContent(), /mps/, 'health 实际设备应来自测量值');
	assert.match(await page.getByTestId('laya-unverified-note').textContent(), /尚未在本机实机验证/, '需声明未实机验证');
	assert.equal(await page.getByTestId('laya-model-row').getAttribute('data-registered'), 'true');

	// 5) 实际操作测试：尚未运行 / 真实执行未验证 / advisory
	await page.getByTestId('benchmark-open-multilingual').click();
	await page.getByTestId('actual-task-test').waitFor();
	assert.match(await page.getByTestId('actual-task-test').textContent(), /专用隔离测试窗口/);
	assert.match(await page.getByTestId('actual-task-preflight').textContent(), /前置条件/);
	assert.match(await page.getByTestId('benchmark-unverified-note').textContent(), /未在真实桌面打开测试窗口/, '需声明未真实执行');
	assert.match(await page.getByTestId('actual-task-verdict').textContent(), /尚未运行/, '未跑过时显示尚未运行');
	await page.getByTestId('actual-task-target').click();
	await page.getByRole('option', { name: /助理电脑/ }).click();
	await page.getByTestId('actual-task-ack').check();
	await page.getByTestId('actual-task-start').click();
	await page.waitForFunction(() => document.querySelector('[data-testid=actual-task-verdict]')?.textContent?.includes('偏慢'), null, { timeout: 5000 });
	const resultText = await page.getByTestId('actual-task-result').textContent();
	assert.match(resultText, /冷启动（单次）/, '需单列冷启动');
	assert.match(resultText, /任务成功率/, '需显示任务成功率');
	assert.match(resultText, /总用时/, '需显示总用时');
	assert.match(resultText, /步骤延迟 p50（诊断）/, 'p50 应标为步骤诊断');
	assert.match(resultText, /不代表整个 CUA 速度/, '需声明不代表整个 CUA 速度');
	assert.match(resultText, /本轮不执行主模型回退/, '不得把 fallbackCount 当接管收益');
	assert.equal(benchPosts.length, 1, '应发出一次 benchmark POST');
	assert.ok(['hostpc', 'computer'].includes(benchPosts[0].target), 'POST target 必须是 hostpc | computer');
	if (SHOT) await page.getByTestId('actual-task-test').screenshot({ path: `${SHOT}/2-actual-task-test.png` });
	await page.getByTestId('actual-task-use-anyway').click();

	// 6) Laya 停止：不删配置，模型显示未就绪
	await page.getByTestId('laya-stop').click();
	await page.waitForTimeout(80);
	assert.match(await page.getByTestId('laya-runtime-state').textContent(), /未运行/);
	assert.equal(await page.getByTestId('laya-model-row').getAttribute('data-registered'), 'false');
	assert.match(await page.getByTestId('laya-model-row').textContent(), /未就绪/, '停止后模型显示未就绪，不删配置');
	assert.ok(await page.getByTestId('laya-start').isVisible(), '停止后仍可启动');

	// 7) Laya 卸载：自绘确认框（不是原生 confirm）；取消不变，确认后回到未安装
	await page.getByTestId('laya-uninstall').click();
	await page.getByTestId('confirm-dialog').waitFor();
	assert.match(await page.getByTestId('confirm-dialog').textContent(), /卸载本地 Laya/);
	await page.getByTestId('confirm-cancel').click();
	await page.waitForTimeout(60);
	assert.match(await page.getByTestId('laya-install-state').textContent(), /已安装/, '取消卸载后状态不变');
	await page.getByTestId('laya-uninstall').click();
	await page.getByTestId('confirm-ok').click();
	await page.waitForTimeout(80);
	assert.match(await page.getByTestId('laya-install-state').textContent(), /未安装/, '确认后卸载');
	assert.ok(await page.getByTestId('laya-install').isVisible(), '卸载后显示一键安装');

	// 8) Esc 关弹窗（键盘可达）
	await page.getByTestId('add-service-open').click();
	await page.getByTestId('add-service').waitFor();
	await page.keyboard.press('Escape');
	await page.waitForTimeout(80);
	assert.equal(await page.getByTestId('add-service').count(), 0, 'Esc 应关闭添加服务弹窗');

	// 9) 390 宽不横向溢出
	await page.setViewportSize({ width: 390, height: 780 });
	await page.reload();
	await page.getByTestId('settings-dialog').waitFor();
	await panel.waitFor();
	if (SHOT) await page.locator('[data-testid=model-services]').screenshot({ path: `${SHOT}/3-services-390.png` });
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	assert.ok(overflow <= 1, `390 宽不应横向溢出（实际 ${overflow}px）`);

	const nativeDialogs = await page.evaluate(() => window.__nativeDialogs ?? 0);
	assert.equal(nativeDialogs, 0, '不得调用原生 confirm/alert/prompt');
	console.log('通过：统一模型服务原型（能力标签/纠正、添加服务、Laya 管理卡安装/运行/未就绪/卸载确认、实际操作测试 availability/未验证/advisory、Esc、390 宽、无原生 dialog）。');
} finally {
	await browser?.close();
	web.close();
}
