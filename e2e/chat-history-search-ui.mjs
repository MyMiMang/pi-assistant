// Real temporary Mock server, built web app and a fresh Playwright browser profile.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactDir } from './fixtures/artifacts.mjs';
import { drafts, keyword, mainName, roomName, roomBName, searchPage, startSearchFixture, wait } from './fixtures/chat-history-search.mjs';

const out = artifactDir('chat-history-search');
const { base, server, seedBase, launchBrowser, cleanup } = await startSearchFixture();
let browser, page;
try {
	const { agent } = await seedBase();
	console.log('PASS temporary real Mock server, isolated SQLite fixture (39 messages)');

	browser = await launchBrowser();
	page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN', colorScheme: 'light' });
	page.setDefaultTimeout(8500);
	const pageErrors = [];
	page.on('pageerror', (err) => pageErrors.push(err.message));
	const { trigger, modal, field, rows, composer, open, close, count, roomButton, chooseConversation } = searchPage(page);
	const contains = async (text) => assert.ok((await rows.allTextContents()).some((s) => s.includes(text)), text);
	const closeKeepsDraft = async (value) => {
		await close();
		assert.equal(await composer.inputValue(), value);
	};
	const shot = async (file) => {
		await modal.getByRole('status').waitFor();
		await page.screenshot({ path: join(out, file), animations: 'disabled' });
		console.log(`SCREENSHOT ${file}`);
	};
	await page.goto(`${base}/?agent=${agent.id}`);
	await chooseConversation(mainName);
	const appearance = async (skin, label) => {
		await page.getByRole('button', { name: '设置', exact: true }).click();
		await page.getByTestId('settings-nav').locator('button[data-tab=appearance]').click();
		await page.locator(`button[data-theme-id=${skin}]`).click();
		await page.getByRole('button', { name: label, exact: true }).click();
		await page.keyboard.press('Escape');
	};
	const themeColors = () => modal.evaluate((el) => {
		const style = getComputedStyle(el);
		return [document.documentElement.dataset.mode, style.backgroundColor, style.color];
	});
	await appearance('warm', '浅色');
	await composer.fill(drafts.single);
	await open(keyword);
	await count(30);
	await contains('Milestone 34');
	assert.ok((await rows.allTextContents()).every((s) => s.includes('Milestone')));
	assert.ok(await rows.first().locator('time[datetime]').count());
	const light = await themeColors();
	assert.equal(light[0], 'light');
	await shot('desktop-1440-single-light.png');
	const more = page.waitForResponse((r) => r.url().includes('/messages/search') && new URL(r.url()).searchParams.has('cursor'));
	await modal.getByRole('button', { name: '加载更多' }).click();
	assert.equal((await more).status(), 200);
	await count(34);
	assert.deepEqual((await rows.allTextContents()).map((s) => Number(s.match(/Milestone (\d+)/)[1])), Array.from({ length: 34 }, (_, i) => 34 - i));
	assert.equal(await modal.getByRole('button', { name: '加载更多' }).count(), 0);
	await field.fill('mIlEsToNe 01');
	await count(1);
	await contains('Milestone 01');
	await closeKeepsDraft(drafts.single);
	assert.equal(await trigger.evaluate((el) => el === document.activeElement), true, 'focus returns to trigger');
	await chooseConversation('另一条对话');
	await open(keyword);
	await count(1);
	await contains('另一对话');
	await close();
	console.log('PASS single scope: same-agent conversations isolated; Chinese + ASCII case-fold; page 30→34 newest-first at equal timestamps; Escape, focus, draft');

	await roomButton(roomName).click();
	await page.getByTestId('room-title').filter({ hasText: roomName }).waitFor();
	await composer.fill(drafts.room);
	await open(keyword);
	await count(2);
	assert.ok((await rows.allTextContents()).every((s) => s.includes('设计群')));
	await closeKeepsDraft(drafts.room);
	console.log('PASS group scope: matching single chats/other room excluded; group draft retained');

	// Hold, then deliver the actual old-room server response after selecting the next room.
	// Synthetic click uses the real sidebar handler; the modal rightly blocks pointer clicks behind it.
	const gate = Promise.withResolvers();
	const upstream = Promise.withResolvers();
	const delivery = Promise.withResolvers();
	await page.route('**/messages/search?*', async (route) => {
		if (new URL(route.request().url()).searchParams.get('q') !== '迟到响应') return route.continue();
		try {
			const response = await route.fetch();
			const body = await response.json();
			assert.deepEqual(body.items.map((m) => m.id), ['fixture-late']);
			upstream.resolve(response.status());
			await gate.promise;
			const outcome = await route.fulfill({ response }).then(() => 'fulfill completed', (err) => `delivery cancelled: ${err.message.split('\n')[0]}`);
			delivery.resolve(outcome);
		} catch (err) { upstream.reject(err); delivery.resolve('upstream failed'); }
	});
	try {
		await open('迟到响应');
		assert.equal(await Promise.race([upstream.promise, new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000))]), 200);
		await roomButton(roomBName).evaluate((el) => el.click());
		await modal.waitFor({ state: 'hidden' });
		await open(keyword);
		await count(1);
		await contains('测试群专属');
	} finally { gate.resolve(); }
	const outcome = await delivery.promise;
	await count(1);
	await contains('测试群专属');
	assert.ok(!(await modal.textContent()).includes('仅旧设计群可见'));
	await close();
	console.log(`PASS late result: real upstream returned 200, released after new room loaded; ${outcome}; no stale result shown`);

	await roomButton(roomName).click();
	assert.equal(await composer.inputValue(), drafts.room);
	await appearance('noir', '深色');
	await open(keyword);
	await count(2);
	const dark = await themeColors();
	assert.equal(dark[0], 'dark');
	assert.notEqual(light[1], dark[1], 'dialog background follows theme');
	assert.notEqual(light[2], dark[2], 'dialog text follows theme');
	await shot('desktop-1440-group-dark.png');
	await close();
	await page.setViewportSize({ width: 390, height: 844 });
	await open(keyword);
	await count(2);
	await wait(async () => {
		const box = await modal.boundingBox();
		const input = await field.boundingBox();
		return box && input && box.x >= 0 && box.x + box.width <= 390 && input.x >= 0 && input.x + input.width <= 390;
	}, 'dialog and search input inside 390px viewport');
	await shot('mobile-390-group-dark.png');
	await closeKeepsDraft(drafts.room);
	assert.deepEqual(pageErrors, []);
	console.log(`PASS theme warm light ${light.slice(1)} → noir dark ${dark.slice(1)}; 390px contained; no uncaught page errors`);
} catch (err) {
	if (page) {
		await page.screenshot({ path: join(out, 'failure.png'), animations: 'disabled', timeout: 3000 }).catch(() => {});
		console.error((await page.locator('body').innerText({ timeout: 3000 }).catch(() => '')).slice(0, 2500));
	}
	throw err;
} finally {
	await browser?.close();
	await server.stop();
	writeFileSync(join(out, 'ui-server.log'), server.logs());
	cleanup();
}
