// 渠道测试用固定密钥，不读取或修改用户的 macOS 钥匙串。
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";

const original = childProcess.execFileSync;
mock.method(childProcess, "execFileSync", (file: string, ...args: unknown[]) => {
	if (file !== "security") return Reflect.apply(original, childProcess, [file, ...args]);
	const argv = args[0] as string[];
	if (argv[0] !== "find-generic-password" || !argv.includes("credential-master-key")) throw new Error("Unexpected keychain access in channel test");
	return Buffer.alloc(32, 7).toString("hex");
});
syncBuiltinESMExports();
