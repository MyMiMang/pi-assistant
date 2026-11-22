/** Built web UI → real temp service → synthetic loopback catalog. No inference. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { browserEnv } from "./fixtures/temp-server.mjs";
import { withChannelModelAdd, existingModel, sharedModel, extraModel, skippedModel } from "./fixtures/channel-model-add.mjs";

assert.ok(existsSync(new URL("../apps/web/dist/index.html", import.meta.url)), "build @pi-assistant/web first");
await withChannelModelAdd(async ({ base, run, a, b, custom, snapshot, picker, hits, failure, json, catalogs }) => {
	const agent = await json("/api/agents", "POST", { name: "保留模型选择", model: { provider: b.id, id: sharedModel }, thinking: "off" });
	const bBefore = [await snapshot(b.id), await picker(b.id)];
	const aBefore = await snapshot(a.id);
	const selection = async () => [(await json("/api/agents")).find((x) => x.id === agent.id).model, await json("/api/models/defaults")];
	const selectionBefore = await selection();
	assert.equal(selectionBefore[0]?.provider, b.id);
	assert.equal(selectionBefore[0]?.id, sharedModel);
	const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	try {
		const width = Number(process.env.PIA_VIEWPORT ?? 1440);
		const page = await browser.newPage({ viewport: { width, height: 1000 }, isMobile: width === 390, hasTouch: width === 390, serviceWorkers: "block" });
		page.setDefaultTimeout(8000);
		const errors = [], writes = [];
		page.on("pageerror", (e) => errors.push(e.message));
		page.on("request", (r) => {
			const path = new URL(r.url()).pathname;
			if (r.method() !== "GET" && !path.endsWith("/read") && (/^\/api\/(agents|rooms)(\/|$)/.test(path) || path === "/api/models/default" || path === "/api/models/picks" || path === "/api/models/test" || path === `${custom}/${a.id}` || path === `${custom}/${b.id}`)) writes.push({ path, method: r.method(), body: r.postDataJSON() });
		});
		await page.goto(`${base}/?settings=models`);
		const toggle = page.getByTestId(`service-toggle-${a.id}`);
		if (!(await toggle.isVisible())) await page.getByTestId("service-list-toggle").click();
		await toggle.click();
		const detail = page.getByTestId(`relay-detail-${a.id}`);
		const panel = detail.getByTestId("relay-add-panel");
		const open = () => detail.getByTestId("relay-add-open").click();
		const cancel = async () => { await panel.getByRole("button", { name: "取消", exact: true }).click(); await panel.waitFor({ state: "hidden" }); };
		const input = panel.getByTestId("relay-add-input");
		const manualPreview = panel.getByTestId("relay-add-preview");
		const submit = panel.getByTestId("relay-add-save");
		const checkbox = (id) => panel.getByRole("checkbox", { name: id, exact: true });
		const aPath = `${custom}/${a.id}`;
		const save = async () => {
			const [response] = await Promise.all([page.waitForResponse((r) => new URL(r.url()).pathname === aPath && r.request().method() === "PUT"), submit.click()]);
			assert.ok(response.ok(), await response.text());
			await panel.waitFor({ state: "hidden" });
		};

		await detail.getByTestId(`service-edit-${a.id}`).click();
		const draft = detail.getByRole("textbox", { name: "服务名称" });
		await draft.fill("不要保存的连接草稿");
		await open();
		await checkbox(sharedModel).check();
		assert.equal(await checkbox(existingModel).isDisabled(), true);
		const sharedRow = checkbox(sharedModel).locator("xpath=ancestor::label");
		assert.match(await sharedRow.innerText(), /能识图/);
		assert.match(await sharedRow.getByTestId("relay-add-capability").innerText(), /可选：高/);
		await cancel();
		assert.deepEqual(await snapshot(a.id), aBefore);
		assert.deepEqual(writes, []);
		assert.equal(await draft.inputValue(), "不要保存的连接草稿");

		await open();
		await checkbox(sharedModel).check();
		await checkbox(skippedModel).check();
		failure.add("a");
		await panel.getByTestId("relay-fetch").click();
		assert.match(await panel.getByRole("alert").innerText(), /503/);
		assert.equal(await submit.isDisabled(), true);
		assert.deepEqual(await snapshot(a.id), aBefore);
		failure.delete("a");
		const removed = catalogs.a.pop();
		assert.equal(removed.id, skippedModel);
		await panel.getByTestId("relay-fetch").click();
		await checkbox(sharedModel).waitFor();
		assert.equal(await checkbox(sharedModel).isChecked(), true);
		assert.equal(await checkbox(skippedModel).count(), 0);
		assert.match(await submit.innerText(), /添加 1 款/);
		catalogs.a.push(removed);
		await panel.getByRole("button", { name: "手动输入型号" }).click();
		await input.fill(existingModel);
		await panel.getByText("当前渠道已有这个型号。").waitFor();
		assert.equal(await submit.isDisabled(), true);

		// Hold an actual API response until B is previewed, then release A out of order.
		const staleId = "fixture-stale-manual-r60";
		const manualId = "fixture-manual-unlisted-r65";
		const hold = Promise.withResolvers(), inFlight = Promise.withResolvers(), done = Promise.withResolvers();
		await page.route(`**${aPath}/add-preview`, async (route) => {
			if (route.request().postDataJSON().modelId !== staleId) return route.continue();
			try {
				const response = await route.fetch();
				assert.ok(response.ok());
				inFlight.resolve();
				await hold.promise;
				await route.fulfill({ response }).catch(() => {}); // Chromium may already have aborted it.
			} catch (e) { inFlight.reject(e); }
			finally { done.resolve(); }
		});
		try {
			await input.fill(staleId);
			await Promise.race([inFlight.promise, page.waitForTimeout(8000).then(() => { throw new Error("stale preview request did not start"); })]);
			await input.fill(`  ${manualId}  `);
			await manualPreview.getByText(manualId, { exact: true }).waitFor();
		} finally { hold.resolve(); }
		await done.promise;
		assert.match(await manualPreview.innerText(), /待确认/);
		await save();
		assert.deepEqual((await snapshot(a.id)).models.map((m) => m.id), [existingModel, manualId]);
		assert.equal(await draft.inputValue(), "不要保存的连接草稿");

		await open();
		await checkbox(sharedModel).check();
		await checkbox(extraModel).check();
		assert.equal(await checkbox(skippedModel).isChecked(), false);
		await save();
		const saved = await snapshot(a.id);
		assert.deepEqual(saved.models.slice(0, 2).map((m) => m.id), [existingModel, manualId]);
		assert.deepEqual(saved.models.slice(2).map((m) => m.id).sort(), [sharedModel, extraModel].sort());
		assert.deepEqual(saved.models[0], aBefore.models[0]);
		assert.equal(saved.name, aBefore.name);
		assert.equal(await draft.inputValue(), "不要保存的连接草稿");
		assert.deepEqual([await snapshot(b.id), await picker(b.id)], bBefore);
		assert.deepEqual(await selection(), selectionBefore);
		assert.deepEqual(writes.map(({ path, method }) => [path, method]), [[aPath, "PUT"], [aPath, "PUT"]]);
		for (const { body } of writes) assert.ok(body.models.every((model) => !Object.hasOwn(model, "effectiveCapability")));
		assert.deepEqual(errors, []);
		assert.ok(hits.length >= 5);
		console.log("PASS browser cancel, failed refresh/retry, stale preview, manual + multi-select, connection draft and model selection unchanged");
	} finally { await browser.close(); }
});
