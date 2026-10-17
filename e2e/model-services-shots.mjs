/**
 * 统一模型服务界面 · 当前整合版实拍截图（纯前端 fixture，一次性安全脚本）。
 *
 * 只用静态托管的 apps/web/dist + page.route 拦 /api，不启动 packages/server/src/main.ts、
 * 不碰系统钥匙串 / 真实用户配置 / 真实账户 / 真实 API。数据是内存 mock（页面会明确标注
 * 「测试示例数据」横幅），Laya 用「未安装」态，避免被误认为已实机安装。
 *
 * 用法：node e2e/model-services-shots.mjs
 * 输出目录：由 OUT_DIR 指定（默认 workspace evidence/model-services-current-<时间戳>-<commit>）。
 */
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const dist = join(root, 'apps/web/dist');
if (!existsSync(join(dist, 'index.html'))) {
	console.error('找不到 apps/web/dist/index.html；先跑 `npm run build -w @pi-assistant/web`');
	process.exit(2);
}

const sha = async (p) => createHash('sha256').update(await readFile(p)).digest('hex');
const commit = (await import('node:child_process')).execSync('git rev-parse HEAD', { cwd: root }).toString().trim();
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(process.env.OUT_DIR ?? join(root, '..', 'evidence', `model-services-current-${ts}-${commit.slice(0, 8)}`));
await mkdir(outDir, { recursive: true });

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
	defaultModel: { provider: 'openai', id: 'gpt-4o' }, credentialBackend: 'file',
	sandbox: { mode: 'workspace', preference: 'workspace', dockerAvailable: false }, entryDomain: null,
	tunnel: { enabled: false, state: 'off', mode: 'quick', url: null, failures: 0, rendezvous: { state: 'off' }, binary: null, named: {} },
	workspaceRoot: '/tmp/ws', push: { publicKey: 'pk' }, seq: 1,
};

// Laya 未安装态（截图重点：不让人误以为已实机安装）
const layaUninstalled = {
	platform: { key: 'darwin-arm64', os: 'macOS', arch: 'arm64', accelerator: 'mps', support: 'supported', torchBackend: 'default', pins: [], reason: '' },
	install: { state: 'not_installed', phase: 'idle', received: 0, total: null, error: null, installedAt: null },
	runtime: { state: 'stopped', pid: null, port: null, host: '127.0.0.1' },
	health: null,
	registered: null,
	source: { project: 'Laya', repoUrl: 'https://example.invalid/laya', weightsOrg: 'Laya', codeLicense: 'Apache-2.0', weightsLicense: 'see repo', version: 'v1', reviewedRevisions: {} },
};

const official = [
	{ id: 'openai', name: 'OpenAI', custom: false, configured: true, modelCount: 2, apiKey: { name: 'API Key' } },
	{ id: 'anthropic', name: 'Anthropic', custom: false, configured: false, modelCount: 3, apiKey: { name: 'API Key' } },
];
const officialRegistryModels = {
	openai: [
		{ provider: 'openai', id: 'gpt-4o', name: 'GPT-4o', type: 'chat', capabilities: ['chat', 'vision'], protocol: 'openai-completions', confirmed: true, inferred: [], source: 'pi-catalog', configured: true },
	],
};
const customProviders = [
	{ id: 'custom-relay', name: '示例中转站', api: 'openai-completions', baseUrl: 'https://relay.example.com/v1', headerNames: [], noKey: false, configured: true, createdAt: 1, models: [
		{ id: 'deepseek-v3', capabilities: ['chat'] },
		{ id: 'mystery-model', capabilities: ['chat', 'vision'] },
	] },
];
const registry = () => {
	const out = [];
	for (const o of official) {
		if (!o.configured) continue;
		out.push({ id: o.id, name: o.name, kind: 'builtin', configured: true, protocols: ['openai-completions'], models: officialRegistryModels[o.id] ?? [] });
	}
	for (const c of customProviders) {
		out.push({ id: c.id, name: c.name, kind: 'custom', configured: true, baseUrl: c.baseUrl, protocols: [c.api], models: c.models.map((m) => ({ provider: c.id, id: m.id, name: m.id, type: 'chat', capabilities: m.capabilities, protocol: c.api, confirmed: true, inferred: [], source: 'custom', configured: true })) });
	}
	return out; // 未安装 Laya 不进 registry
};
const customJson = () => ({ providers: customProviders.map((p) => ({ ...p, references: { defaultModel: false, visionModel: false, agents: [], subagents: false, subagentAgents: [] } })), apis: [{ id: 'openai-completions', label: 'OpenAI 兼容' }], classifierProtocols: ['typesafe-system-one'] });

let browser;
try {
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
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
		if (path === '/api/model-strengths') return json(route, { labels: [{ key: 'coding', label: '编码' }], models: [{ provider: 'openai', providerName: 'OpenAI', id: 'gpt-4o', name: 'GPT-4o', tags: [], tierLabel: '旗舰', userEdited: false }] });
		if (path === '/api/models/providers') return json(route, official);
		if (path === '/api/models') return json(route, [{ provider: 'openai', id: 'gpt-4o', name: 'GPT-4o', type: 'chat', capabilities: ['chat', 'vision'], thinking: ['low', 'medium', 'high'], configured: true }]);
		if (path === '/api/models/defaults') return json(route, { thinking: 'medium' });
		if (path === '/api/models/vision') return json(route, { setting: null, current: null, source: 'none', candidates: [] });
		if (path === '/api/models/custom' && method === 'GET') return json(route, customJson());
		if (path === '/api/models/registry' && method === 'GET') return json(route, { providers: registry() });
		if (path === '/api/image-models' && method === 'GET') return json(route, { kinds: [{ kind: 'openai', label: 'OpenAI 兼容', baseUrl: 'https://api.openai.com/v1', models: ['gpt-image-1'] }], providers: [], models: [], default: null, reusable: customProviders.map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, api: p.api })) });
		if (path === '/api/subagents/settings') return json(route, { settings: { maxConcurrent: 10, maxMinutes: 10 }, models: [] });
		return json(route, {});
	});

	await page.goto(`${base}/?settings=models`);
	await page.getByTestId('settings-dialog').waitFor();
	await page.getByTestId('model-services-panel').waitFor();
	// 明确标注：这是静态 mock 示例数据（角标要放进弹窗内部，否则元素截图会把它裁掉）
	const labelInside = (testId, text, fontSize = 12) => page.evaluate(({ testId, text, fontSize }) => {
		const host = document.querySelector(`[data-testid=${testId}]`);
		if (!host) return;
		host.style.position = 'relative';
		const b = document.createElement('div');
		b.id = 'fixture-badge';
		b.textContent = text;
		b.style.cssText = `position:absolute;top:4px;left:50%;transform:translateX(-50%);z-index:99999;background:#b45309;color:#fff;font-size:${fontSize}px;padding:3px 10px;border-radius:999px;box-shadow:0 1px 4px rgba(0,0,0,.3);pointer-events:none;white-space:nowrap`;
		host.appendChild(b);
	}, { testId, text, fontSize });
	await labelInside('settings-dialog', '测试示例数据（静态 fixture，非真实配置 / 非实机安装）');
	await page.waitForTimeout(200);

	const dlg = page.getByTestId('settings-dialog');
	const shots = [];
	const shot = async (name, locator) => {
		const p = join(outDir, name);
		await locator.screenshot({ path: p });
		shots.push(name);
	};
	await shot('01-settings-models-desktop-top.png', dlg);
	// 面板较长：把设置弹窗内部滚到底，露出统一说明与本地 Laya（未安装）
	await page.evaluate(() => {
		const d = document.querySelector('[data-testid=settings-dialog]');
		const scroller = d?.querySelector('.overflow-y-auto');
		if (scroller) scroller.scrollTop = scroller.scrollHeight;
	});
	await page.waitForTimeout(200);
	await shot('02-settings-models-desktop-bottom.png', dlg);

	// 添加服务弹窗（官方完整目录）
	await page.getByTestId('add-service-open').click();
	await page.getByTestId('add-service').waitFor();
	await page.getByTestId('add-service-official-grid').waitFor();
	await labelInside('add-service', '测试示例数据（静态 fixture）');
	await page.waitForTimeout(150);
	await shot('03-add-service-modal-desktop.png', page.getByTestId('add-service'));
	await page.keyboard.press('Escape');
	await page.waitForTimeout(80);

	// 390 手机：顶部
	await page.setViewportSize({ width: 390, height: 844 });
	await page.reload();
	await page.getByTestId('settings-dialog').waitFor();
	await page.getByTestId('model-services-panel').waitFor();
	await labelInside('settings-dialog', '测试示例数据（静态 fixture）', 11);
	await page.waitForTimeout(200);
	await shot('04-settings-models-390-top.png', page.getByTestId('settings-dialog'));

	// 记录来源：commit + dist build 摘要
	const manifest = {
		note: '静态前端 fixture 截图（非真实用户配置）',
		commit,
		distIndexSha256: await sha(join(dist, 'index.html')),
		distAssets: {},
		shots,
		generatedAt: new Date().toISOString(),
	};
	for (const f of shots) manifest.distAssets[f] = await sha(join(outDir, f));
	await writeFile(join(outDir, 'MANIFEST.txt'), JSON.stringify(manifest, null, 2));
	console.log(`OUT_DIR=${outDir}`);
	for (const f of shots) console.log(join(outDir, f));
} finally {
	await browser?.close();
	web.close();
}
