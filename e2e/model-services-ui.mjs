import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

// 统一模型服务 UI 专项测试（纯前端 fixture）：
// 静态托管 apps/web/dist，page.route 拦截所有 /api，不启动 packages/server/src/main.ts，
// 因此不碰系统钥匙串、不碰真实用户配置、不跑真实 API 收费、不装模型、不操作电脑。
// fixture 用内存状态真实模拟 CRUD：POST/PUT/DELETE /api/models/custom 会改动状态，GET /api/models/registry 从中派生，
// 不是把 demo 数据直接塞进界面。覆盖：
//   能力标签（含「未确认」）/ 能力纠正 PUT / 官方完整目录（未接入也能点开登录）/ 自定义服务新增保存（真实 POST）/
//   编辑（PUT）/ 测试连接 / 删除确认（DELETE）/ 生图适配按 keyFrom 绑定同一个 provider /
//   Esc 关弹窗 / 390 宽 / 无原生 dialog。
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

// ---- 内存状态：模拟真实 CRUD（fixture 不是直接塞 demo 给界面）----
const official = [
	{ id: 'mock', name: 'Mock', custom: false, configured: true, modelCount: 1, apiKey: { name: 'API Key' } },
	{ id: 'openai', name: 'OpenAI', custom: false, configured: true, modelCount: 2, apiKey: { name: 'API Key' } },
	{ id: 'anthropic', name: 'Anthropic', custom: false, configured: false, modelCount: 3, apiKey: { name: 'API Key' } },
];
const officialRegistryModels = {
	openai: [
		{ provider: 'openai', id: 'gpt-4o', name: 'GPT-4o', type: 'chat', capabilities: ['chat', 'vision'], protocol: 'openai-completions', confirmed: true, inferred: [], source: 'pi-catalog', configured: true },
	],
};
let customProviders = [
	{ id: 'custom-relay', name: '我的中转站', api: 'openai-completions', baseUrl: 'https://relay.example.com/v1', headerNames: [], noKey: false, configured: true, createdAt: 1, models: [
		{ id: 'deepseek-v3', capabilities: ['chat'] },
		{ id: 'mystery-model', capabilities: ['chat', 'vision'] },
	] },
];
let imageProviders = [];
let loginPosts = [];
let capPuts = [];
let customWrites = [];
let testPosts = [];
let benchPosts = [];
const availability = { cuaReady: true, modelReady: true, fixtureReady: true, reasons: [] };
const benchmarkRun = (status, provenance) => ({
	id: 'b1', status, provider: 'local-laya', model: 'multilingual', modelVersion: 'unknown', provenance,
	target: { prefix: 'computer', fixtureId: 'fix-1' }, startedAt: new Date(Date.now() - 9000).toISOString(), finishedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
	warmup: 2, samples: 24, coldStartMs: 1320, p50Ms: 860, p95Ms: 1420, p95Approx: false,
	timeouts: 0, errors: 1, successRatio: 0.92, actions: 30, retries: 2, fallbackCount: 0, abstains: 1,
	correctness: 0.9, correctTrials: 22, note: '样本 24 条；p50 仅为步骤诊断，不代表整个 CUA 速度。',
	advisory: { verdict: 'slow', recommended: true, message: 'p50 略高于目标预算，仍可继续使用。', reason: 'p50 > budget' },
	reason: null,
});
let benchProvenance = 'cua';

const registry = () => {
	const out = [];
	for (const o of official) {
		if (o.id === 'mock' || !o.configured) continue;
		out.push({ id: o.id, name: o.name, kind: 'builtin', configured: true, protocols: ['openai-completions'], models: officialRegistryModels[o.id] ?? [] });
	}
	for (const c of customProviders) {
		const models = c.models.map((m) => ({ provider: c.id, id: m.id, name: m.id, type: 'chat', capabilities: m.capabilities?.length ? m.capabilities : ['chat'], protocol: c.api, confirmed: true, inferred: [], source: 'custom', configured: true }));
		for (const cl of c.classifiers ?? []) models.push({ provider: c.id, id: cl.modelId, name: cl.modelId, type: 'classifier', capabilities: ['classifier'], protocol: cl.protocol, confirmed: true, inferred: [], source: 'custom', configured: true });
		out.push({ id: c.id, name: c.name, kind: 'custom', configured: true, baseUrl: c.baseUrl, protocols: [c.api], models });
	}
	for (const ip of imageProviders) {
		const shared = ip.keyFrom ? out.find((p) => p.id === ip.keyFrom) : null;
		let target = shared;
		if (!target) {
			target = { id: ip.id, name: ip.name, kind: 'imagegen', configured: true, baseUrl: ip.baseUrl, protocols: [ip.kind], models: [] };
			out.push(target);
		}
		for (const m of ip.models) target.models.push({ provider: target.id, id: m, name: m, type: 'image', capabilities: ['image'], protocol: ip.kind, confirmed: true, inferred: [], source: 'imagegen', configured: true, edit: true, imageAdapter: { kind: ip.kind, baseUrl: ip.baseUrl, edit: true } });
	}
	return out;
};
const customJson = () => ({ providers: customProviders.map((p) => ({ ...p, references: { defaultModel: false, visionModel: false, agents: [], subagents: false, subagentAgents: [] } })), apis: [{ id: 'openai-completions', label: 'OpenAI 兼容' }], classifierProtocols: ['typesafe-system-one'] });
const imageJson = () => ({ kinds: [{ kind: 'openai', label: 'OpenAI 兼容', baseUrl: 'https://api.openai.com/v1', models: ['gpt-image-1'] }], providers: imageProviders, models: imageProviders.flatMap((p) => p.models.map((m) => ({ provider: p.id, providerName: p.name, id: m, edit: true, cost: null }))), default: null, reusable: customProviders.map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, api: p.api })) });

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
	page.on("pageerror", (e) => console.error("  ⚠️ pageerror", String(e.stack ?? e).slice(0, 700)));
	const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
	await page.route('**/api/**', async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		const method = req.method();
		if (path === '/api/system') return json(route, system);
		if (path === '/api/agents') return json(route, []);
		if (path === '/api/rooms') return json(route, []);
		if (path === '/api/downloads') return json(route, { items: [] });
		if (path === '/api/host-control') return json(route, { settings: { enabled: false, agents: 'all', apps: [], workspaceFiles: false, tiers: {}, defaultTier: 'bounded' }, tiers: {}, status: { enabled: false, tiers: {}, paused: false, daemon: { state: 'off', detail: '' }, platform: 'darwin', installed: false, version: '' }, manifest: '', manifestHash: '', permissions: null, activity: { active: false, agent: null, summary: null } });
		if (path.startsWith('/api/proactive/inbox')) return json(route, { items: [], count: 0, defaultLevel: 'normal' });
		if (path === '/api/model-strengths') return json(route, { labels: [{ key: 'coding', label: '编码' }], models: [{ provider: 'openai', providerName: 'OpenAI', id: 'gpt-4o', name: 'GPT-4o', tags: [], tierLabel: '旗舰', userEdited: false }] });
		if (path === '/api/models/providers') return json(route, official);
		if (path === '/api/models/vision') return json(route, { setting: null, current: null, source: 'none', candidates: [] });
		if (path === '/api/models/custom' && method === 'GET') return json(route, customJson());
		if (path === '/api/models/custom' && method === 'POST') {
			const body = req.postDataJSON();
			customWrites.push({ method: 'POST', body });
			const id = `custom-${customWrites.length}`;
			customProviders = [...customProviders, { id, name: body.name, api: body.api, baseUrl: body.baseUrl, headerNames: [], noKey: !!body.noKey, configured: !!body.apiKey || !!body.noKey, createdAt: Date.now(), models: body.models ?? [], classifiers: body.classifiers ?? [] }];
			return json(route, customProviders.find((p) => p.id === id));
		}
		if (/^\/api\/models\/custom\/[^/]+$/.test(path) && method === 'PUT') {
			const id = path.split('/').pop();
			const body = req.postDataJSON();
			customWrites.push({ method: 'PUT', id, body });
			customProviders = customProviders.map((p) => (p.id === id ? { ...p, name: body.name, api: body.api, baseUrl: body.baseUrl, configured: p.configured || !!body.apiKey, models: body.models ?? p.models, classifiers: body.classifiers ?? p.classifiers } : p));
			return json(route, customProviders.find((p) => p.id === id));
		}
		if (/^\/api\/models\/custom\/[^/]+$/.test(path) && method === 'DELETE') {
			const id = path.split('/').pop();
			customWrites.push({ method: 'DELETE', id });
			customProviders = customProviders.filter((p) => p.id !== id);
			return json(route, { ok: true });
		}
		if (path === '/api/models/custom/fetch-models') return json(route, { models: [{ id: 'gpt-4o', contextWindow: 128000, maxTokens: 16384, limitsSource: 'known' }, { id: 'gpt-image-1', contextWindow: 32000, maxTokens: 4096, limitsSource: 'known' }] });
		if (path === '/api/models/registry' && method === 'GET') return json(route, { providers: registry() });
		if (path === '/api/models' && method === 'GET') return json(route, []);
		if (path === '/api/audio/asr/providers' && method === 'GET') return json(route, { protocols: ['openai-audio-transcriptions', 'local-asr-http'], providers: [] });
		if (path === '/api/local-models/asr/sensevoice/status' && method === 'GET')
			return json(route, {
				platform: { key: 'darwin-arm64', os: 'darwin', arch: 'arm64', support: 'supported' },
				license: { licenseName: 'FunASR Model Open Source License Agreement', termsVersion: '1.1', decision: 'unresolved', redistribution: false, attribution: 'a', links: { modelCard: 'https://h/', modelLicense: 'https://l/', issue: 'https://i/', engineLicense: 'https://e/' }, restrictions: ['r1'], reason: 'why', acceptValue: '1.1' },
				install: { state: 'not_installed', phase: 'idle', received: 0, total: null, error: null, source: null },
				runtime: { state: 'stopped', pid: null, port: null, host: '127.0.0.1', lastError: null },
				configured: false,
				registered: null,
				source: { project: 'SenseVoice', repoUrl: 'https://r/', weightsRepo: 'w', weightsRevision: 'v', weightsLicense: 'wl', note: 'n' },
				model: { id: 'sensevoice-small-int8', bytes: 1, sampleRate: 16000, channels: 1, languages: ['zh'], punctuation: true },
				notes: ['未实测'],
			});
		if (/^\/api\/models\/registry\/[^/]+\/models\/[^/]+\/capabilities$/.test(path) && method === 'PUT') {
			const [, , , providerId, , modelId] = path.split('/');
			const body = req.postDataJSON();
			capPuts.push({ providerId, modelId, body });
			customProviders = customProviders.map((p) => (p.id !== providerId ? p : { ...p, models: p.models.map((m) => (m.id !== modelId ? m : { ...m, capabilities: body.capabilities })) }));
			return json(route, { providers: registry() });
		}
		if (path === '/api/models/test') {
			testPosts.push(req.postDataJSON());
			return json(route, { ok: true, message: '连接成功（fixture）' });
		}
		if (path === '/api/models/login' && method === 'POST') {
			loginPosts.push(req.postDataJSON());
			return json(route, { flowId: 'f1' });
		}
		if (/^\/api\/models\/login\/[^/]+$/.test(path) && method === 'GET') return json(route, { done: false, events: [] });
		if (path === '/api/image-models' && method === 'GET') return json(route, imageJson());
		if (path === '/api/image-models/providers' && method === 'POST') {
			const body = req.postDataJSON();
			const id = `img-${imageProviders.length + 1}`;
			imageProviders = [...imageProviders, { id, name: body.name, kind: body.kind, kindLabel: 'OpenAI 兼容', baseUrl: body.baseUrl, models: body.models, keyFrom: body.keyFrom ?? null, hasKey: true }];
			return json(route, imageProviders.find((p) => p.id === id));
		}
		if (/^\/api\/image-models\/providers\/[^/]+$/.test(path) && method === 'DELETE') {
			imageProviders = imageProviders.filter((p) => p.id !== path.split('/').pop());
			return json(route, { ok: true });
		}
		if (path === '/api/fast-computer/settings') return json(route, { settings: { enabled: false, kind: 'systemone', provider: '', id: '' }, models: [], classifierModels: [] });
		if (path === '/api/subagents/settings') return json(route, { settings: { maxConcurrent: 10, maxMinutes: 10 }, models: [] });
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
		if (path === '/api/fast-computer/benchmark' && method === 'GET') return json(route, { availability, runs: [] });
		if (path === '/api/fast-computer/benchmark' && method === 'POST') { benchPosts.push(req.postDataJSON()); return json(route, { ok: true, run: benchmarkRun('running', benchProvenance) }); }
		if (path === '/api/fast-computer/benchmark/b1' && method === 'GET') return json(route, benchmarkRun('done', benchProvenance));
		if (path === '/api/fast-computer/benchmark/b1/cancel') return json(route, { ok: true });
		return json(route, {});
	});

	await page.goto(`${base}/?settings=models`);
	await page.getByTestId('settings-dialog').waitFor();
	const panel = page.getByTestId('model-services-panel');
	await panel.waitFor();
	const cards = () => page.locator('[data-testid=service-card]');
	assert.equal(await cards().count(), 2, 'registry 里 2 个服务卡片（openai + custom-relay）');
	const SHOT = process.env.SHOT_DIR;
	if (SHOT) await page.locator('[data-testid=model-services]').screenshot({ path: `${SHOT}/1-services-desktop.png` });

	// 1) 能力标签：推断出来的能力标「未确认」；能力纠正 → PUT registry
	const relay = page.locator('[data-testid=service-card][data-service=custom-relay]');
	await relay.getByTestId('service-toggle-custom-relay').click();
	const mystery = page.locator('[data-testid=service-model][data-model=mystery-model]');
	await mystery.getByTestId('model-capability-toggle').click();
	await mystery.getByTestId('cap-image').check();
	await mystery.getByTestId('cap-save').click();
	await page.waitForTimeout(80);
	assert.equal(capPuts.length, 1, '应发出一次能力纠正 PUT');
	assert.ok(capPuts[0].body.capabilities.includes('image'), '纠正内容应含 image');
	assert.match(await mystery.getByTestId('model-caps').textContent(), /生图/, '纠正后应显示生图标签');

	// 2) 生图适配：把 mystery-model 的生图能力绑定到同一个 provider（keyFrom），不新建第二套 Key
	await relay.getByTestId('image-adapter-bind-custom-relay').click();
	await page.waitForTimeout(80);
	assert.equal(imageProviders.length, 1, '应创建一个生图适配');
	assert.equal(imageProviders[0].keyFrom, 'custom-relay', '生图适配必须复用同一个 provider 的 Key');
	assert.equal(imageProviders[0].models[0], 'mystery-model', '生图模型应来自同一服务的生图能力');
	await relay.getByTestId('image-adapter-bound-custom-relay').waitFor();
	assert.match(await relay.getByTestId('image-adapter-bound-custom-relay').textContent(), /复用本服务 Key/, '绑定后标明复用同一个 Key');

	// 3) 官方完整目录：未接入的官方服务也能点开（走公开登录 API）
	await page.getByTestId('add-service-open').click();
	await page.getByTestId('add-service').waitFor();
	await page.getByTestId('add-service-official-grid').waitFor();
	assert.ok(await page.getByTestId('official-provider-anthropic').isVisible(), '未接入的官方服务应出现在完整目录里');
	await page.getByTestId('official-provider-anthropic').click();
	await page.getByTestId('official-login-anthropic').waitFor();
	// 点开 API Key 登录 → POST /api/models/login（公开登录流程），不需要真实 Key
	await page.getByTestId('official-login-anthropic').getByRole('button', { name: /API Key/ }).click();
	await page.waitForTimeout(80);
	assert.equal(loginPosts.length, 1, '应发出一次登录请求');
	assert.equal(loginPosts[0].provider, 'anthropic', '登录请求应指向所选官方服务');
	await page.getByTestId('add-service').getByRole('button', { name: '取消' }).click();
	await page.waitForTimeout(60);

	// 4) 添加自定义服务：真实 POST /api/models/custom，保存后 registry 派生出新卡片
	await page.getByTestId('add-service-open').click();
	await page.getByTestId('add-service').waitFor();
	await page.getByTestId('add-service-kind').click();
	await page.getByRole('option', { name: /自定义/ }).click();
	const form = page.getByTestId('custom-provider-form');
	await form.waitFor();
	await form.getByPlaceholder('例如：我的中转站').fill('新中转');
	await form.getByPlaceholder('https://api.example.com/v1').fill('https://new.example.com/v1');
	await form.getByPlaceholder('sk-…').fill('sk-test-not-real');
	await form.getByRole('button', { name: /自动获取/ }).click();
	await page.getByRole('button', { name: 'gpt-4o', exact: true }).click();
	await form.getByRole('button', { name: /^保存$/ }).click();
	await page.waitForTimeout(120);
	assert.equal(customWrites.filter((w) => w.method === 'POST').length, 1, '应发出一次 POST 保存自定义服务');
	assert.equal(customWrites[0].body.baseUrl, 'https://new.example.com/v1', '地址一次保存到 provider');
	assert.equal(customWrites[0].body.apiKey, 'sk-test-not-real', 'Key 随同一次保存');
	assert.equal(await cards().count(), 3, '保存后 registry 派生出新卡片');

	// 5) 测试连接（真实 POST /api/models/test）+ 编辑（PUT）
	const added = page.locator('[data-testid=service-card][data-service=custom-1]');
	await added.getByTestId('service-toggle-custom-1').click();
	await added.getByTestId('service-test-run-custom-1').click();
	await added.getByTestId('service-test-result-custom-1').waitFor();
	assert.match(await added.getByTestId('service-test-result-custom-1').textContent(), /连接成功/, '测试连接应显示成功');
	assert.equal(testPosts.length, 1, '应发出一次测试连接请求');
	await added.getByTestId('service-edit-custom-1').click();
	const editForm = page.getByTestId('custom-provider-form');
	await editForm.getByPlaceholder('例如：我的中转站').fill('新中转改名');
	await editForm.getByRole('button', { name: /保存修改/ }).click();
	await page.waitForTimeout(120);
	assert.equal(customWrites.filter((w) => w.method === 'PUT').length, 1, '应发出一次 PUT 编辑');
	assert.ok(customProviders.some((p) => p.name === '新中转改名'), '编辑应改动状态');

	// 6) 删除确认 → DELETE；取消不动
	await added.getByTestId('service-delete-custom-1').click();
	await page.getByTestId('confirm-dialog').waitFor();
	await page.getByTestId('confirm-cancel').click();
	await page.waitForTimeout(60);
	assert.ok(customProviders.some((p) => p.id === 'custom-1'), '取消删除后服务仍在');
	await added.getByTestId('service-delete-custom-1').click();
	await page.getByTestId('confirm-ok').click();
	await page.waitForTimeout(120);
	assert.equal(customWrites.filter((w) => w.method === 'DELETE').length, 1, '应发出一次 DELETE');
	assert.ok(!customProviders.some((p) => p.id === 'custom-1'), '删除后状态里不再有该服务');
	assert.equal(await cards().count(), 2, '删除后卡片恢复为 2 个');

	// 11) 回到模型页 → Esc 关弹窗（键盘可达）
	await page.goto(`${base}/?settings=models`);
	await page.getByTestId('settings-dialog').waitFor();
	await panel.waitFor();
	await page.getByTestId('add-service-open').click();
	await page.getByTestId('add-service').waitFor();
	await page.keyboard.press('Escape');
	await page.waitForTimeout(80);
	assert.equal(await page.getByTestId('add-service').count(), 0, 'Esc 应关闭添加服务弹窗');

	// 12) 390 宽不横向溢出
	await page.setViewportSize({ width: 390, height: 780 });
	await page.reload();
	await page.getByTestId('settings-dialog').waitFor();
	await panel.waitFor();
	if (SHOT) await page.locator('[data-testid=model-services]').screenshot({ path: `${SHOT}/3-services-390.png` });
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	assert.ok(overflow <= 1, `390 宽不应横向溢出（实际 ${overflow}px）`);

	const nativeDialogs = await page.evaluate(() => window.__nativeDialogs ?? 0);
	assert.equal(nativeDialogs, 0, '不得调用原生 confirm/alert/prompt');
	console.log('通过：统一模型服务真实 CRUD（官方完整目录登录 / 自定义新增保存编辑删除 / 测试连接 / 生图 keyFrom 绑定）、能力纠正、Esc、390 宽、无原生 dialog（电脑快速操作模型与 Laya 已撤下，不再有安装卡 / 实际操作测试入口）。');
} finally {
	await browser?.close();
	web.close();
}
