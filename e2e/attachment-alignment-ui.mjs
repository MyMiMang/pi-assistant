import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from './fixtures/temp-server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'artifacts/attachment-alignment');
mkdirSync(out, { recursive: true });
const run = makeTempRun('pia-attachment-alignment-');
const port = await new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`;
const server = startTempServer({ root, port, run });
const baseline = process.env.ATTACHMENT_BASELINE === '1';
let browser;
try {
	const deadline = Date.now() + 30000;
	while (!(await fetch(`${base}/api/system`).then(r => r.ok, () => false))) {
		if (Date.now() > deadline) throw new Error('临时服务未启动');
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	const json = async (path, method, data) => {
		const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
		assert.ok(response.ok, `${path}: ${response.status}`);
		return response.json();
	};
	await json('/api/settings', 'PUT', { onboarded: true });
	const agent = await json('/api/agents', 'POST', { name: '附件布局测试', model: { provider: 'mock', id: 'echo' } });
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, env: browserEnv(run) });
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
	await page.goto(`${base}/?agent=${agent.id}`);
	const workspace = page.getByTestId('right-workspace');
	await workspace.and(page.locator('[data-scope*="conversation:"]:not([data-scope$="conversation:"])')).waitFor({ state: 'attached' });
	await page.getByTestId('agent-detail-open').click();
	await page.getByTestId('info-tabs').waitFor();
	const bytes = Buffer.from(await page.evaluate(() => {
		const canvas = document.createElement('canvas'); canvas.width = 1800; canvas.height = 600;
		const ctx = canvas.getContext('2d');
		for (const [i, color] of ['#2b5797', '#328276', '#d28a3d'].entries()) { ctx.fillStyle = color; ctx.fillRect(i * 600, 0, 600, 600); }
		ctx.fillStyle = '#fff'; ctx.font = 'bold 96px sans-serif'; ctx.fillText('WIDE IMAGE 1800 × 600', 72, 330);
		return canvas.toDataURL('image/png').split(',')[1];
	}), 'base64');
	await page.getByTestId('attach-input').setInputFiles({ name: 'wide-fixture.png', mimeType: 'image/png', buffer: bytes });
	await page.locator('.pa-composer textarea').fill('这是一张合成宽图');
	const send = page.getByRole('button', { name: '发送', exact: true });
	await send.click();
	const row = page.locator('.pa-msg.user').filter({ hasText: '这是一张合成宽图' });
	const attachment = row.getByTestId('image-attachment');
	const image = attachment.locator('img');
	await image.waitFor();
	await image.evaluate(img => img.decode());
	const downloadButton = attachment.getByRole('button', { name: '下载', exact: true });
	for (const mode of ['desktop', '390']) {
		if (mode === '390') {
			await workspace.getByTestId('workspace-collapse').click();
			await workspace.waitFor({ state: 'hidden' });
			await page.setViewportSize({ width: 390, height: 844 });
		} else await page.getByTestId('info-tabs').waitFor();
		await image.scrollIntoViewIfNeeded();
		await page.screenshot({ path: join(out, `${baseline ? 'before' : 'after'}-${mode}.png`), animations: 'disabled' });
		const [wrapper, photo, button, bubble] = await Promise.all([attachment.boundingBox(), image.boundingBox(), downloadButton.boundingBox(), row.locator('.pa-bubble').boundingBox()]);
		const right = box => box.x + box.width;
		console.log(mode, JSON.stringify({ wrapper, photo, button, bubble }));
		if (baseline) continue;
		assert.ok(photo.width <= 301 && Math.abs(photo.width - wrapper.width) <= 1, '外层与图片宽度一致且不超过缩略图上限');
		assert.ok(Math.abs(right(photo) - right(bubble)) <= 1, '图片与本人气泡右边缘对齐');
		assert.ok(button.x >= photo.x && right(button) <= right(photo) && button.y >= photo.y && button.y + button.height <= photo.y + photo.height, '下载按钮贴在图内');
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), mode === '390' ? 390 : 1440);
		let unexpectedDownloads = 0;
		const count = () => { unexpectedDownloads++; };
		page.on('download', count);
		await image.click({ position: { x: 20, y: 20 } });
		const viewer = page.getByTestId('image-viewer');
		await viewer.waitFor();
		assert.equal(unexpectedDownloads, 0, '预览不触发下载');
		page.off('download', count);
		await page.keyboard.press('Escape');
		await viewer.waitFor({ state: 'hidden' });
		const [download] = await Promise.all([page.waitForEvent('download'), downloadButton.click()]);
		assert.equal(download.suggestedFilename(), 'wide-fixture.png');
		assert.deepEqual(readFileSync(await download.path()), bytes, '下载保持原始文件内容');
		assert.equal(await viewer.count(), 0, '下载不打开预览');
		console.log(`PASS ${mode} 图片对齐、按钮贴图、预览和下载独立`);
	}
} finally { await browser?.close(); await server.stop(); cleanupTempRun(run); }
