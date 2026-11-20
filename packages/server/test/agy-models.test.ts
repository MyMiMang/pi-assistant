import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { agyThinkingMap, effortsOf, parseAgyModels, resolveAgyModel, resolveAgySelection } from "../src/cli-agents/agy-models.ts";

test("同 stem 的不同显示名不合并成可切换档位的家族", () => {
	for (const rows of [["ambiguous-high\tAlpha (High)", "ambiguous-xhigh\tBeta (XHigh)"], ["ambiguous-xhigh\tBeta (XHigh)", "ambiguous-high\tAlpha (High)"]]) {
		const families = parseAgyModels(rows.join("\n"));
		assert.deepEqual(families.map((f) => f.id).sort(), ["ambiguous-high", "ambiguous-xhigh"]);
		assert.deepEqual(families.map(effortsOf), [[], []]);
		assert.equal(resolveAgyModel(families, "ambiguous-high", undefined), "ambiguous-high");
		assert.throws(() => resolveAgyModel(families, "ambiguous-high", "xhigh"), /不支持/);
		assert.throws(() => resolveAgyModel(families, "ambiguous", "xhigh"), /找不到/);
	}
});

const LEGACY_DIRECTORY = [
	"Fetching available models...",
	"unit-alpha-medium\tUnit Alpha (Medium)",
	"unit-alpha-high\tUnit Alpha (High)",
	"unit-alpha-low\tUnit Alpha (Low)",
	"unit-fixed\tUnit Fixed (Preview)",
].join("\r\n");

test("legacy TSV retains catalog order, exact suffix variants, and fixed IDs", () => {
	const families = parseAgyModels(LEGACY_DIRECTORY);
	assert.deepEqual(families.map((f) => [f.id, f.name, effortsOf(f)]), [
		["unit-alpha", "Unit Alpha", ["low", "medium", "high"]],
		["unit-fixed", "Unit Fixed (Preview)", []],
	]);
	assert.equal(resolveAgyModel(families, "unit-alpha", "high"), "unit-alpha-high");
	assert.equal(resolveAgyModel(families, "unit-alpha", undefined), "unit-alpha-medium");
	assert.equal(resolveAgyModel(families, "unit-fixed", undefined), "unit-fixed");
	assert.deepEqual(parseAgyModels("Error: Please sign in to view available models."), []);
});

test("合成 Neon Hydrogen：两种归组证据、完整五档，基础行在最后也优先作为默认", () => {
	const familyId = `test-neon-hydrogen-${randomUUID()}`;
	const name = "Neon Hydrogen (Preview)";
	const families = parseAgyModels([
		`${familyId}-max\t${name} (MAX)`,
		`${familyId}-high\t${name}`,
		`${familyId}-xhigh\t${name} (XHigh)`,
		`${familyId}-medium\t${name} (Medium)`,
		`${familyId}-low\t${name} (Low)`,
		`${familyId}\t${name}`,
	].join("\n"));
	assert.deepEqual(families.map((f) => [f.id, f.name]), [[familyId, name]]);
	const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
	assert.deepEqual(effortsOf(families[0]), efforts);
	assert.deepEqual(agyThinkingMap(families[0]), { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
	for (const effort of efforts) {
		assert.deepEqual(resolveAgySelection(families, familyId, effort), { modelId: `${familyId}-${effort}`, familyId, effort, source: "explicit" });
	}
	assert.deepEqual(resolveAgySelection(families, familyId), { modelId: familyId, familyId, source: "default-base" });
	for (const effort of ["off", "minimal", "constructor", "MAX", ""]) {
		assert.throws(() => resolveAgyModel(families, familyId, effort), /不支持思考档位/);
	}
});

test("裸后缀、冲突括号、不同名基础行及仅有括号的模型均保留固定完整 ID 和名称", () => {
	const fixed = {
		"unit-fixed-max": "Unit Fixed Max",
		"unit-label-only": "Unit Label Only (Max)",
		"unit-mismatch-high": "Unit Mismatch (Low)",
		"unit-other": "Unit Other",
		"unit-other-low": "Different Edition (Low)",
	};
	const families = parseAgyModels(Object.entries(fixed).map(([id, name]) => `${id}\t${name}`).join("\n"));
	assert.deepEqual(families.map((f) => [f.id, f.name]), Object.entries(fixed));
	for (const f of families) {
		assert.deepEqual(effortsOf(f), []);
		assert.equal(agyThinkingMap(f), undefined);
		assert.equal(resolveAgyModel(families, f.id, undefined), f.id);
		for (const effort of ["off", "low", "max"]) assert.throws(() => resolveAgyModel(families, f.id, effort), /不支持思考档位/);
	}
	assert.throws(() => resolveAgyModel(families, "unit-fixed", undefined), /找不到模型/);
});

test("无基础行的默认有独立来源；仍在目录的旧完整 ID 保留原档位，失效或冲突就拒绝", () => {
	const families = parseAgyModels(LEGACY_DIRECTORY + "\r\nunit-single-max\tUnit Single (Max)");
	assert.deepEqual(resolveAgySelection(families, "unit-alpha"), {
		modelId: "unit-alpha-medium", familyId: "unit-alpha", effort: "medium", source: "default-variant",
	});
	assert.deepEqual(resolveAgySelection(families, "unit-single"), {
		modelId: "unit-single-max", familyId: "unit-single", effort: "max", source: "default-variant",
	});
	assert.equal(resolveAgyModel(families, "unit-single", "max"), "unit-single-max");
	assert.throws(() => resolveAgyModel(families, "unit-single", "high"), /不支持思考档位/);
	assert.deepEqual(resolveAgySelection(families, "unit-alpha-low"), {
		modelId: "unit-alpha-low", familyId: "unit-alpha", effort: "low", source: "legacy-id",
	});
	assert.equal(resolveAgyModel(families, "unit-alpha-low", "low"), "unit-alpha-low");
	assert.throws(() => resolveAgyModel(families, "unit-alpha-low", "high"), /固定为 low/);
	assert.throws(() => resolveAgyModel(families, "unit-alpha-low", "off"), /不支持思考档位/);
	assert.throws(() => resolveAgyModel(families, "unit-alpha-max", undefined), /重新检测并选择模型/);
});
