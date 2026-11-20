import assert from "node:assert/strict";
import test from "node:test";
import { AgyUsageLedger } from "../src/cli-agents/agy-usage.ts";

const totals = (input: number) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 });

test("重复回执不重复结算；新轮按回执来源做差，不以 token 数判重", () => {
	const ledger = new AgyUsageLedger(undefined);
	ledger.startTurn();
	ledger.observeSession("a");
	assert.deepEqual(ledger.finish("a", 1, { input: 100 }), totals(100));
	assert.equal(ledger.finish("a", 1, { input: 100 }), undefined);
	ledger.startTurn();
	assert.deepEqual(ledger.finish("a", 2, { input: 200 }), totals(100));
	ledger.startTurn();
	assert.equal(ledger.finish("a", 2, { input: 240 }), undefined, "相同回执编号即使金额变化也不入账");
});

test("换会话 / 恢复进程不借用旧基线，缺失或矛盾字段不猜测", () => {
	const ledger = new AgyUsageLedger("old");
	ledger.startTurn();
	assert.equal(ledger.finish("old", 8, { input: 200, output: 10 }), undefined);
	ledger.startTurn();
	assert.equal(ledger.finish("wrong", 9, { input: 900 }), undefined);
	ledger.observeStep(totals(40));
	assert.equal(ledger.finish("old", 9, { input: 230 }), undefined);
	ledger.startTurn();
	assert.equal(ledger.finish("old", 10, { input: 400, output: 12 }), undefined);
	ledger.observeSession("new");
	ledger.startTurn();
	assert.equal(ledger.finish("new", 1, { input: 1200 }), undefined);
	ledger.startTurn();
	assert.deepEqual(ledger.finish("new", 2, { input: 1220 }), totals(20));
});
