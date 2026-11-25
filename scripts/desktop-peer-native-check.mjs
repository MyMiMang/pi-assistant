import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const manifest = "apps/tray/src-tauri/Cargo.toml";
const tests = [
	"desktop_peer::tests::same_remote_device_id_survives_reopen_switch_and_forget",
	"desktop_peer::tests::projections_never_include_pairing_material",
];

export function assertExactPass(output, test) {
	const lines = output.split(/\r?\n/);
	assert.equal(lines.filter(line => line === `test ${test} ... ok`).length, 1, `Expected one executed passing test: ${test}`);
	assert.equal(lines.filter(line => /^test result: ok\. 1 passed; 0 failed; 0 ignored; 0 measured;/.test(line)).length, 1, `Expected one passing libtest result: ${test}`);
}

function run(args, capture = false) {
	const result = spawnSync("cargo", [...args, "--locked", "--manifest-path", manifest, ...(capture ? ["--bin", "pi-assistant-tray", "--", "--exact", "--color", "never"] : [])], {
		encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", maxBuffer: 4 * 1024 * 1024,
	});
	if (capture) process.stdout.write(result.stdout ?? "");
	if (result.error) throw result.error;
	assert.equal(result.status, 0, `cargo ${args.join(" ")} failed (${result.signal ?? "exit"})`);
	return result.stdout;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	assert.ok((process.platform === "darwin" && process.arch === "arm64") || (process.platform === "win32" && process.arch === "x64"), "Requires a native Mac arm64 or Windows x64 runner");
	run(["check", "--all-targets"]);
	for (const test of tests) assertExactPass(run(["test", test], true), test);
	console.log(`Native desktop peer gate: ${tests.length}/${tests.length} exact tests passed`);
}
