/** 临时真实 API → 仅本地 /models：预览、保存和公开目录一致，且预览不写入。 */
import assert from "node:assert/strict";
import { withChannelModelAdd, existingModel, sharedModel, extraModel } from "./fixtures/channel-model-add.mjs";

await withChannelModelAdd(async ({ a, b, custom, snapshot, picker, hits, failure, holdCatalog, fetchBody, fetchModels, request, json, restart }) => {
	const previewPath = (p) => `${custom}/${p.id}/add-preview`;
	const preview = (p, modelId) => json(previewPath(p), "POST", { modelId }).then((x) => x.model);
	const state = () => Promise.all([snapshot(a.id), snapshot(b.id), picker(a.id), picker(b.id), json("/api/models/defaults")]);
	const before = await state();
	for (const modelId of [undefined, 42, "   ", "a\nb", "x".repeat(513)]) {
		assert.equal((await request(previewPath(a), "POST", { modelId })).status, 400);
	}
	assert.equal((await request(previewPath({ id: "nonexistent-channel" }), "POST", { modelId: sharedModel })).status, 404);
	const manual = await preview(a, `  ${extraModel}  `);
	assert.equal(manual.id, extraModel);
	assert.equal(manual.effectiveCapability.vision, undefined);
	assert.equal(manual.effectiveCapability.reasoningSource, "渠道范围");
	assert.deepEqual(manual.effectiveCapability.levels, { high: "fixture-high" });
	assert.equal((await preview(b, sharedModel)).effectiveCapability.vision, false);
	assert.deepEqual(hits, [], "manual preview must not fetch or run a model");

	const [listA, listB] = await Promise.all([fetchModels(a), fetchModels(b)]);
	const existing = listA.find((m) => m.id === existingModel);
	const selected = listA.find((m) => m.id === sharedModel);
	assert.equal(existing.listEvidence.vision, false);
	assert.equal(existing.effectiveCapability.vision, true);
	assert.equal(existing.effectiveCapability.visionSource, "手动");
	assert.equal(selected.effectiveCapability.vision, true);
	assert.equal(selected.effectiveCapability.visionSource, "/models");
	assert.equal(selected.effectiveCapability.reasoningSource, "/models");
	assert.deepEqual(selected.effectiveCapability.levels, manual.effectiveCapability.levels);
	assert.equal(listB.find((m) => m.id === sharedModel).effectiveCapability.vision, false);
	assert.deepEqual(await state(), before, "preview and fetch must not write or switch models");

	failure.add("a");
	const failed = await request(`${custom}/fetch-models`, "POST", fetchBody(a));
	assert.ok(!failed.ok);
	assert.match((await failed.json()).error, /503/);
	assert.deepEqual(await state(), before);
	failure.delete("a");

	const stripPreview = ({ effectiveCapability, ...m }) => m;
	await json(`${custom}/${a.id}`, "PUT", { ...before[0], models: [...before[0].models.map(stripPreview), stripPreview(manual), stripPreview(selected)] });
	const after = await state();
	assert.deepEqual(after[0].models.map((m) => m.id), [existingModel, extraModel, sharedModel]);
	assert.deepEqual(after[0].models[0], before[0].models[0]);
	const registry = (await json("/api/models/registry")).providers.find((p) => p.id === a.id);
	for (const candidate of [manual, selected]) {
		for (const list of [after[0].models, after[2]]) {
			assert.deepEqual(list.find((m) => m.id === candidate.id).effectiveCapability, candidate.effectiveCapability, candidate.id);
		}
	}
	assert.equal(registry.models.find((m) => m.id === sharedModel).capabilities.includes("vision"), true);
	assert.equal(registry.models.find((m) => m.id === extraModel).capabilities.includes("vision"), false);
	assert.deepEqual(after[2].find((m) => m.id === sharedModel).thinking, ["high"]);
	assert.deepEqual([after[1], after[3], after[4]], [before[1], before[3], before[4]]);
	const hold = holdCatalog("a");
	const inFlight = request(`${custom}/fetch-models`, "POST", fetchBody(a));
	try {
		await Promise.race([hold.started, inFlight.then((r) => assert.fail(`expected held upstream, got ${r.status}`))]);
		await json(`${custom}/${a.id}`, "PUT", { ...after[0], name: "目录返回前更新渠道", models: after[0].models.map(stripPreview) });
	} finally { hold.release(); }
	assert.equal((await inFlight).status, 409);
	assert.equal((await snapshot(a.id)).name, "目录返回前更新渠道");
	const preRestart = await state();
	await restart();
	assert.deepEqual(await state(), preRestart, "重启后保留渠道证据、手动优先和默认设置");
	console.log("PASS /add-preview, stored /models projection, stale/failed refresh, save/readback/restart, registry/picker parity and channel isolation");
});
