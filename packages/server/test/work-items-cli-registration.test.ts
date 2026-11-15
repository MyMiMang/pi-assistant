import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db, R, S, makeItem, row, runRows, settle, started } from "./work-items-harness.ts";
import { models } from "../src/models.ts";
import { cliServices } from "../src/cli-services.ts";
import { createCliChannelService } from "../src/cli-channel-service.ts";
import { itemRow } from "../src/work-items/store.ts";
import { createRun } from "../src/work-items/exec.ts";
import { launch } from "../src/work-items/launch.ts";

// 复用工作项假 driver，只替换本次测试渠道的模型发现，不起真实命令或模型。
test("工作项等待注册时执行确为 queued；注册成功派出，注册失败任务受阻并给出中文原因", async () => {
	const proto = Object.getPrototypeOf(R.runtime("wa"));
	const oldModelFor = proto.modelFor;
	const oldGet = models.getModel;
	const pick = { provider: "test-work-cli", id: "gemini" };
	let available = false, finish!: () => void, reject!: (e: Error) => void;
	const svc = createCliChannelService({
		id: pick.provider, label: "工作项测试渠道", envName: "WORK_CLI_TEST_COMMAND", managed: true,
		find: () => process.execPath, notFound: "未安装", requireLogin: true,
		detect: async () => ({ installed: true, loggedIn: true }),
		register: async () => { await new Promise<void>((r, j) => { finish = r; reject = j; }); available = true; return { disposeAll() {} }; },
	}, [60_000]);
	cliServices.push(svc);
	proto.modelFor = function(a: { id: string }) { return a.id === "wa" ? pick : oldModelFor.call(this, a); };
	models.getModel = function(provider, id) { return provider === pick.provider ? (available ? oldGet.call(this, "mock", "echo") : undefined) : oldGet.call(this, provider, id); };
	try {
		const item = itemRow(makeItem())!;
		const run = createRun(item, "wa", { task: "等待渠道恢复" });
		assert.equal(run.status, "queued", "createRun 写入 queued；只有派出帮手后才改 running");
		launch(item, run);
		await settle();
		assert.equal(runRows(item.id)[0].status, "queued", JSON.stringify(db.prepare("SELECT * FROM work_item_runs WHERE id = ?").get(run.id)));
		finish();
		const c = await started(item.id);
		assert.equal(runRows(item.id)[0].status, "running");
		assert.ok(c.helperId);
		await S.stopSubagent(c.helperId!);
		available = false;
		// 使用新模型目录状态模拟下一次启动，确保本次真的需要重新注册。
		svc.dispose();
		const failedSvc = createCliChannelService({
			id: pick.provider, label: "工作项测试渠道", envName: "WORK_CLI_TEST_COMMAND", managed: true,
			find: () => process.execPath, notFound: "未安装", requireLogin: true,
			detect: async () => ({ installed: true, loggedIn: true }),
			register: async () => { throw new Error("模型目录请求超时"); },
		}, [60_000]);
		cliServices.splice(cliServices.indexOf(svc), 1, failedSvc);
		try {
			const failedItem = itemRow(makeItem())!;
			const failedRun = createRun(failedItem, "wa", { task: "无法连接" });
			launch(failedItem, failedRun);
			await settle();
			assert.equal(runRows(failedItem.id)[0].status, "error");
			assert.equal(row(failedItem.id).status, "blocked");
			const result = db.prepare("SELECT error FROM work_item_runs WHERE id = ?").get(failedRun.id) as { error: string };
			assert.match(result.error, /工作项测试渠道 暂时没连上（模型目录请求超时），这一轮没有改用其他模型/);
			assert.match(itemRow(failedItem.id)!.latest_progress!, /暂时没连上/);
		} finally { failedSvc.dispose(); cliServices.splice(cliServices.indexOf(failedSvc), 1); }
	} finally {
		reject?.(new Error("测试清理")); svc.dispose();
		const at = cliServices.indexOf(svc); if (at >= 0) cliServices.splice(at, 1);
		proto.modelFor = oldModelFor; models.getModel = oldGet;
	}
});
