import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copySeed } from "../src/config.ts";

test("copySeed 复制整个目录，失败不留半截目录", () => {
	const t = mkdtempSync(join(tmpdir(), "seed-"));
	mkdirSync(join(t, "src", "sub"), { recursive: true });
	writeFileSync(join(t, "src", "a.exe"), "A");
	writeFileSync(join(t, "src", "sub", "b.dll"), "B");
	copySeed(join(t, "src"), join(t, "dst"));
	assert.equal(readFileSync(join(t, "dst", "sub", "b.dll"), "utf8"), "B");
	assert.throws(() => copySeed(join(t, "missing"), join(t, "dst2")));
	assert.equal(existsSync(join(t, "dst2")), false);
	assert.deepEqual(readdirSync(t).sort(), ["dst", "src"]);
});
