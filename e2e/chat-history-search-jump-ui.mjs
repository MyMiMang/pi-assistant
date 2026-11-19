// Stage 2: built app + temporary real Mock server + fresh Chromium profile.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { artifactDir } from './fixtures/artifacts.mjs';
import { drafts, keyword, mainName, roomName, roomBName, searchPage, startSearchFixture, wait } from './fixtures/chat-history-search.mjs';

const out = artifactDir('chat-history-search-stage2');
const fixture = await startSearchFixture();
const { base, server, json, seedBase, seedMessages, launchBrowser, cleanup } = fixture;
const singleQuery = '归档定位';
const roomQuery = '群内同文';
const singleTarget = 'jump-single-a';
const singleTwin = 'jump-single-b';
const groupTarget = 'jump-group-b';
const groupTwin = 'jump-group-a';
const deleted = 'jump-deleted';
const oldTime = Date.UTC(2019, 0, 1);
const newerTime = Date.now() - 5000;
let page, browser;
try {
	const { agent, member, primary, room } = await seedBase({ secondMember: true });
	seedMessages((insert) => {
		for (const [kind, scope, query, total] of [
			['single', { conv: primary.id }, singleQuery, 1600],
			['group', { roomId: room.id }, roomQuery, 240],
		]) {
			const add = (id, text, ts, agentId = agent.id) => insert({ id, text, ts, agentId, ...scope });
			for (let i = 0; i < total; i++) {
				if (i === 61) {
					add(`jump-${kind}-a`, `${query}：同一毫秒、完全相同的原文。`, oldTime + i);
					add(`jump-${kind}-b`, `${query}：同一毫秒、完全相同的原文。`, oldTime + i, kind === 'group' ? member.id : agent.id);
					continue;
				}
				const prefix = kind === 'single' && i >= 500 && i < 565 ? singleQuery + ' · ' : '';
				const context = i === 60 ? '前一条上下文' : i === 62 ? '后一条上下文' : `归档消息 ${i}`;
				add(`jump-${kind}-${i}`, `${prefix}${context} · 补充说明，用来核验前后文和滚动位置。`, oldTime + i);
			}
		}
		insert({ id: deleted, agentId: agent.id, conv: primary.id, text: '待删除定位测试，仅在搜索后删除', ts: oldTime + 300 });
		insert({ id: 'jump-single-latest', agentId: agent.id, conv: primary.id, text: '单聊实时末尾', ts: newerTime });
		insert({ id: 'jump-group-latest', agentId: member.id, roomId: room.id, text: '群聊实时末尾', ts: newerTime });
	});
	browser = await launchBrowser();
	page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN', colorScheme: 'light', serviceWorkers: 'block' });
	page.setDefaultTimeout(7000);
	const errors = [];
	page.on('pageerror', (err) => errors.push(err.message));
	const { trigger, modal, field, list, composer, open, close, count, roomButton, chooseConversation } = searchPage(page);
	const scroll = page.locator('.pa-scroll');
	const anchor = (mid) => scroll.locator(`[data-mid="${mid}"]`);
	const hits = modal.getByTestId('chat-history-search-hit');
	const hit = (mid) => hits.and(modal.locator(`[data-message-id="${mid}"]`));
	const back = page.getByTestId('chat-search-back');
	const latest = page.getByTestId('chat-search-latest');
	const notice = modal.getByTestId('chat-search-notice');
	const history = page.getByTestId('history-window');
	const more = modal.getByRole('button', { name: '加载更多' });
	const hitIds = () => hits.evaluateAll((els) => els.map((el) => el.dataset.messageId));
	const shot = (name) => page.screenshot({ path: join(out, `${name}.png`) });
	const isContext = (url, mid) => new URL(url).pathname === `/api/messages/${mid}/context`;
	const offset = (loc) => loc.evaluate((el) => el.scrollTop);
	const frames = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
	const contains = (loc, text) => wait(async () => (await loc.textContent()).includes(text), text);
	const setRoom = async (name) => {
		await roomButton(name).click();
		await page.getByTestId('room-title').filter({ hasText: name }).waitFor();
	};
	const visible = (loc) => loc.evaluate((el) => {
		const a = el.getBoundingClientRect();
		const c = el.closest('.pa-scroll').getBoundingClientRect();
		return a.top >= c.top && a.bottom <= c.bottom;
	});
	const verifyJump = async ({ mid, twin, kind, scopeKey, scopeId, file }) => {
		assert.equal(await anchor(mid).count(), 0, `${mid} is not initially loaded`);
		assert.equal(await anchor(twin).count(), 0, `${twin} is not initially loaded`);
		const response = page.waitForResponse((r) => isContext(r.url(), mid));
		await hit(mid).click();
		const r = await response;
		assert.equal(r.status(), 200);
		assert.equal(new URL(r.url()).searchParams.get(scopeKey), scopeId);
		const body = await r.json();
		assert.ok(body.messages.length <= 101 && body.hasOlder && body.hasNewer, 'bounded middle history window');
		const ids = body.messages.map((m) => m.id);
		assert.deepEqual(ids.slice(ids.indexOf(`jump-${kind}-60`), ids.indexOf(`jump-${kind}-62`) + 1), [`jump-${kind}-60`, `jump-${kind}-a`, `jump-${kind}-b`, `jump-${kind}-62`]);
		await modal.waitFor({ state: 'hidden' });
		await back.waitFor();
		await wait(() => visible(anchor(mid)), `target ${mid} scrolled into viewport`);
		assert.match(await anchor(mid).getAttribute('class'), /\bpa-msg-flash\b/);
		assert.doesNotMatch(await anchor(twin).getAttribute('class'), /\bpa-msg-flash\b/);
		// Capture the visible midpoint of the transient flash, then resume it.
		const flashAt = (paused) => anchor(mid).evaluate((el, pause) => {
			for (const a of el.getAnimations().filter((a) => a.animationName === 'pa-flash')) {
				if (pause) { a.pause(); a.currentTime = 600; } else a.play();
			}
		}, paused);
		await flashAt(true);
		try { await shot(file); } finally { await flashAt(false); }
		await contains(anchor(`jump-${kind}-60`), '前一条上下文');
		await contains(anchor(`jump-${kind}-62`), '后一条上下文');
		assert.equal(await anchor(`jump-${kind}-latest`).count(), 0, 'no gap merged into history');
		assert.ok(await scroll.locator('[data-mid]').count() <= 101, 'no intervening history bulk-rendered');
	};

	const arrived = Promise.withResolvers();
	page.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => {
		if (String(payload).includes('真推送到达 · 定位时不抢滚动')) arrived.resolve();
	}));
	await page.goto(`${base}/?agent=${agent.id}`);
	await chooseConversation(mainName);
	await anchor('jump-single-latest').waitFor();
	await composer.fill(drafts.single);
	await open(singleQuery);
	await count(30);
	await more.click();
	await count(60);
	await more.click();
	await count(67);
	assert.deepEqual((await hitIds()).slice(-2), [singleTwin, singleTarget]);
	assert.equal(await hit(singleTarget).innerText(), await hit(singleTwin).innerText(), 'identical speaker, timestamp and text; select the second hit');
	await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
	await hit(singleTarget).scrollIntoViewIfNeeded();
	const idsBefore = await hitIds();
	const listTop = await offset(list);
	assert.ok(listTop > 0, 'results are scrolled before opening a hit');
	await verifyJump({ mid: singleTarget, twin: singleTwin, kind: 'single', scopeKey: 'conversationId', scopeId: primary.id, file: 'desktop-1440-single-highlight' });
	assert.equal(await composer.inputValue(), drafts.single);
	await back.click();
	await modal.waitFor();
	await count(67);
	await frames();
	assert.equal(await field.inputValue(), singleQuery);
	assert.equal(await hit(singleTarget).evaluate((el) => el === document.activeElement), true, 'focus returns to clicked result');
	assert.deepEqual(await hitIds(), idsBefore);
	assert.ok(Math.abs(await offset(list) - listTop) <= 3, `results scroll restored: ${await offset(list)} vs ${listTop}`);
	await shot('desktop-1440-restored-results');
	await close();
	console.log('PASS desktop single: exact second identical hit, bounded context, highlight, three result pages + scroll restored, draft');

	// Real independent send through the temporary server exercises WS and storage, not an injected client event.
	await wait(() => visible(anchor(singleTarget)), 'target remains centered before live send');
	await frames();
	const beforeSend = await offset(scroll);
	const text = '真推送到达 · 定位时不抢滚动';
	const sent = await json(`/api/agents/${agent.id}/messages`, 'POST', { conversationId: primary.id, text });
	assert.equal(await Promise.race([arrived.promise.then(() => true), delay(5000, false, { ref: false })]), true, 'real WS event arrived');
	await wait(async () => /有\s*\d+\s*条新消息/.test(await history.textContent()), 'history new message hint');
	await frames();
	assert.ok(Math.abs(await offset(scroll) - beforeSend) <= 3, 'incoming message did not move the history scroll');
	assert.equal(await anchor(sent.id).count(), 0, 'incoming message did not bridge the gap');
	await latest.click();
	await anchor(sent.id).waitFor();
	await history.waitFor({ state: 'hidden' });
	await wait(() => visible(anchor(sent.id)), 'new message visible after return to latest');
	assert.equal(await anchor(singleTarget).count(), 0);
	assert.equal(await composer.inputValue(), drafts.single);
	console.log('PASS real WS: new-message indicator, no scroll steal, return to latest, unchanged draft');

	await trigger.click();
	await field.fill('待删除定位测试');
	await count(1);
	seedMessages((_insert, remove) => remove(deleted));
	await hit(deleted).click();
	await contains(notice, '原消息已删除或不可见');
	assert.ok(await modal.isVisible());
	assert.equal(await field.inputValue(), '待删除定位测试');
	assert.equal(await composer.inputValue(), drafts.single);
	await close();
	console.log('PASS deleted hit: leaves results and draft intact, shows actionable notice');

	await setRoom(roomName);
	await anchor('jump-group-latest').waitFor();
	await composer.fill(drafts.room);
	await open(roomQuery);
	await count(2);
	assert.deepEqual(await hitIds(), [groupTarget, groupTwin]);
	assert.match(await hit(groupTarget).innerText(), /验收同事/);
	assert.match(await hit(groupTwin).innerText(), /验收助理/);
	await verifyJump({ mid: groupTarget, twin: groupTwin, kind: 'group', scopeKey: 'roomId', scopeId: room.id, file: 'desktop-1440-group-highlight' });
	await latest.click();
	await anchor('jump-group-latest').waitFor();
	assert.equal(await composer.inputValue(), drafts.room);
	console.log('PASS desktop group: same content and millisecond from different members resolves exact clicked ID');

	// Delay the real old-scope context response. The modal blocks pointer clicks behind it,
	// so invoke the real sidebar click handler as in the stage 1 stale-search test.
	const held = Promise.withResolvers();
	const release = Promise.withResolvers();
	const delivered = Promise.withResolvers();
	await page.route((url) => isContext(url, groupTarget), async (route) => {
		try {
			const response = await route.fetch();
			assert.equal(response.status(), 200);
			assert.ok((await response.json()).messages.some((m) => m.id === groupTarget));
			held.resolve(true);
			await release.promise;
			delivered.resolve(await route.fulfill({ response }).then(() => 'delivered', () => 'client cancelled'));
		} catch (err) { held.resolve(err); delivered.resolve('upstream failed'); }
	});
	try {
		await trigger.click();
		await hit(groupTarget).click();
		assert.equal(await Promise.race([held.promise, delay(5000, 'timeout', { ref: false })]), true);
		await roomButton(roomBName).evaluate((el) => el.click());
		await anchor('fixture-room-b').waitFor();
		await modal.waitFor({ state: 'hidden' });
		await open(keyword);
		await count(1);
	} finally { release.resolve(); }
	const delivery = await delivered.promise;
	await frames();
	assert.deepEqual(await hitIds(), ['fixture-room-b']);
	assert.equal(await back.count(), 0);
	assert.equal(await anchor(groupTarget).count(), 0);
	assert.equal(await history.count(), 0);
	await close();
	await page.unrouteAll({ behavior: 'wait' });
	console.log(`PASS late room context: real old response ${delivery}; new room and search untouched`);

	await setRoom(roomName);
	await anchor('jump-group-latest').waitFor();
	assert.equal(await composer.inputValue(), drafts.room);
	await page.setViewportSize({ width: 390, height: 844 });
	await open(roomQuery);
	await count(2);
	await verifyJump({ mid: groupTarget, twin: groupTwin, kind: 'group', scopeKey: 'roomId', scopeId: room.id, file: 'mobile-390-group-highlight' });
	for (const control of [back, latest]) {
		const box = await control.boundingBox();
		assert.ok(box && box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844, 'navigation control fits narrow viewport');
	}
	await back.click();
	await count(2);
	assert.equal(await field.inputValue(), roomQuery);
	await shot('mobile-390-restored-results');
	await close();
	await latest.click();
	await anchor('jump-group-latest').waitFor();
	assert.equal(await composer.inputValue(), drafts.room);
	assert.deepEqual(errors, []);
	console.log('PASS mobile 390: jump, nonoverflowing controls, return to results + latest, unchanged draft; no uncaught page errors');
} catch (err) {
	if (page) await page.screenshot({ path: join(out, 'failure.png'), timeout: 3000 }).catch(() => {});
	throw err;
} finally {
	await browser?.close();
	await server.stop();
	writeFileSync(join(out, 'ui-server.log'), server.logs());
	cleanup();
}
