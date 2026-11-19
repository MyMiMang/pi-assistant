// Stage 3 only: real browser keys while a real temporary search response is held in transit.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactDir } from './fixtures/artifacts.mjs';
import { mainName, searchPage, startSearchFixture, wait } from './fixtures/chat-history-search.mjs';

const out = artifactDir('chat-history-search-stage3');
const { base, server, seedBase, seedMessages, launchBrowser, cleanup } = await startSearchFixture();
const oldQuery = 'needle';
const suffix = 'latest';
const latestQuery = oldQuery + suffix;
const oldId = 'typing-old';
const latestId = 'typing-latest';
const addedRows = 20_000;
const keyDelayMs = 35;
const hold = Promise.withResolvers();
const stale = { startedAt: null, upstream: null, delivery: null };
let browser;
try {
	const { agent, primary } = await seedBase();
	let addedContentBytes = 0;
	seedMessages((insert) => {
		const paragraph = 'Synthetic archive entry with **formatted notes** and [a reference](https://example.invalid). '.repeat(10);
		for (let i = 0; i < addedRows; i++) {
			const text = `${i === 0 ? `${latestQuery} ` : i === 1 ? `${oldQuery} obsolete ` : ''}${i} ${paragraph}`;
			insert({ id: i === 0 ? latestId : i === 1 ? oldId : `typing-${i}`, agentId: agent.id, conv: primary.id, text, ts: Date.UTC(2019, 0, 1) + i });
			addedContentBytes += Buffer.byteLength(text);
		}
	});

	browser = await launchBrowser();
	const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN', serviceWorkers: 'block' });
	page.setDefaultTimeout(15_000);
	const errors = [];
	page.on('pageerror', (err) => errors.push(err.message));
	const { field, modal, chooseConversation, open } = searchPage(page);
	const hits = modal.getByTestId('chat-history-search-hit');
	await page.route('**/messages/search?*', async (route) => {
		if (new URL(route.request().url()).searchParams.get('q') !== oldQuery) return route.continue();
		try {
			stale.startedAt = performance.now();
			const response = await route.fetch({ timeout: 15_000 });
			const upstreamMs = performance.now() - stale.startedAt;
			assert.equal(response.status(), 200);
			assert.deepEqual((await response.json()).items.map((item) => item.id), [oldId, latestId]);
			stale.upstream = { status: response.status(), upstreamMs };
			await hold.promise;
			stale.delivery = await route.fulfill({ response }).then(() => 'fulfilled', () => 'no longer deliverable');
		} catch (error) { stale.error = error; }
	});
	await page.goto(`${base}/?agent=${agent.id}`);
	await chooseConversation(mainName);
	await open('');
	await page.keyboard.type(oldQuery);
	assert.equal(await field.inputValue(), oldQuery);
	await wait(() => stale.startedAt !== null, 'old search dispatched to real server');
	await field.evaluate((el) => {
		const samples = [];
		let key;
		el.addEventListener('keydown', (e) => { if (e.isTrusted) key = { key: e.key, at: e.timeStamp }; });
		el.addEventListener('input', (e) => {
			if (!key || !e.isTrusted) return;
			const { key: char, at } = key;
			key = undefined;
			const value = el.value;
			const keyToInputMs = performance.now() - at;
			// rAF callbacks run before paint; double rAF brackets a presentation opportunity, not a measured paint.
			requestAnimationFrame(() => requestAnimationFrame(() => samples.push({
				char, value, frameValue: el.value, keyAt: at, keyToInputMs, keyToFrameMs: performance.now() - at,
			})));
		});
		window.typingSamples = samples;
	});
	await page.keyboard.type(suffix, { delay: keyDelayMs });
	await page.waitForFunction((n) => window.typingSamples.length === n, suffix.length);
	const samples = await page.evaluate(() => window.typingSamples);
	assert.equal(samples.map((s) => s.char).join(''), suffix);
	assert.deepEqual(samples.map((s) => s.value), [...suffix].map((_, i) => oldQuery + suffix.slice(0, i + 1)));
	// Frames may coalesce on a busy CI runner. Each observed frame must include that key (or a later one).
	assert.ok(samples.every((s) => s.frameValue.startsWith(s.value)));
	assert.equal(samples.at(-1).frameValue, latestQuery);
	assert.equal(await field.inputValue(), latestQuery);
	assert.equal(stale.delivery, null, 'old response still withheld after all keys');

	const latestResultMs = await page.waitForFunction((id) => {
		const results = document.querySelectorAll('[data-testid="chat-history-search-hit"]');
		if (results.length === 1 && results[0].dataset.messageId === id && results[0].getBoundingClientRect().height > 0) {
			return performance.now() - window.typingSamples.at(-1).keyAt;
		}
	}, latestId).then((handle) => handle.jsonValue());
	assert.equal(stale.delivery, null, 'latest result visible before old response is released');
	await wait(() => stale.upstream || stale.error, 'real old-query response');
	if (stale.error) throw stale.error;
	const oldReleaseMs = performance.now() - stale.startedAt;
	hold.resolve();
	await wait(() => stale.delivery || stale.error, 'late response delivery attempt');
	if (stale.error) throw stale.error;
	await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
	assert.deepEqual(await hits.evaluateAll((els) => els.map((el) => el.dataset.messageId)), [latestId]);
	assert.deepEqual(errors, []);
	const report = {
		platform: `${process.platform}/${process.arch}`, node: process.version, browser: browser.version(),
		conversationRows: addedRows + 34, addedRows, addedContentBytes, keyDelayMs,
		oldQuery: { ...stale.upstream, requestToReleaseMs: oldReleaseMs, delivery: stale.delivery },
		lastKeyToLatestVisibleDomMs: latestResultMs, samples,
	};
	writeFileSync(join(out, 'typing-metrics.json'), JSON.stringify(report, null, 2) + '\n');
	console.log('PASS real browser typing during held search; latest result visible before release and unchanged afterwards');
	console.log(JSON.stringify(report));
} finally {
	hold.resolve();
	await browser?.close();
	await server.stop();
	writeFileSync(join(out, 'ui-server.log'), server.logs());
	cleanup();
}
