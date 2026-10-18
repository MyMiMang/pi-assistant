// node --test scripts/hindsight-update.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { bumpPyproject, pinnedVersion } from "./hindsight-update.mjs";

test("升级脚本：pyproject 两个 Python 包一起换版本，exclude-newer 跟着推", () => {
	const src = readFileSync(new URL("../packages/server/hindsight/pyproject.toml", import.meta.url), "utf8");
	const cur = pinnedVersion(src);
	assert.match(cur, /^\d+\.\d+\.\d+/);
	const out = bumpPyproject(src, "9.9.9", "2030-01-01T00:00:00Z");
	assert.equal(pinnedVersion(out), "9.9.9");
	assert.match(out, /"hindsight-embed==9\.9\.9"/);
	assert.match(out, /"hindsight-api-slim\[local-onnx,embedded-db\]==9\.9\.9"/);
	assert.match(out, /exclude-newer = "2030-01-01T00:00:00Z"/);
	assert.match(out, /"flashrank==0\.2\.10"/, "别的依赖不动");
});
