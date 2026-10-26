/**
 * 单测启动前置：**强制**把数据目录指向本次进程专属的临时目录，并关掉外网。
 *
 * 加载方式（两者都要，缺一不可）：
 *  - `npm test` 与定向命令用 `--import ./test/setup.ts` **在测试模块求值之前预加载**（见 package.json `test`）；
 *  - 测试文件里把 `import "./setup.ts";` 作为**第一条**静态 import（ESM 按 import 声明顺序求值，排在会
 *    import `../src/config.ts` 的模块之前），这样即使有人直接 `node --test test/foo.test.ts` 绕过预加载也安全。
 *
 * 为什么必须这么早：`src/config.ts` 在**模块求值时**就把 `PIA_DATA_DIR` 读进 `config.dataDir` 并 `mkdirSync` 建目录。
 * 旧写法在模块体里 `await import("./setup.ts")`，而 ESM 静态 import 早于模块体求值 —— config 于是先执行、捕获真实
 * 数据目录，setup 设的环境变量来得太晚。2026-10-15 因此把测试助理「小微」（id `wa`）连同工作区写进用户库；
 * 2026-10-16 又有一条 Laya 依赖测试因此把 `local-laya/runtime/weights/rl_agent_config.json` 写进真实数据目录。
 *
 * 必须用 `=` 覆盖，不能用 `??=`：`??=` 会沿用外部环境里的 PIA_DATA_DIR（例如为了调试真实数据 export 过），
 * 单测于是直接读写用户真实数据目录。同理 PIA_WORKSPACE 也要一起固定，避免工作区落到别处。
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve, sep } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "pia-test-"));
process.env.PIA_DATA_DIR = dataDir;
process.env.PIA_WORKSPACE = join(dataDir, "workspace");
process.env.PIA_OFFLINE = "1";
// 单测不因为开发机装了 claude 就改变模型列表（空 = 明确关闭 Claude Code 渠道）；要测它的用例自己设假 claude 路径。
process.env.PIA_CLAUDE_COMMAND = "";
// codex / agy 同理（非 Mock 的用例启动服务时，不能去跑开发机上真实的 codex / agy，agy models 还要联网、很慢）。
process.env.PIA_CODEX_COMMAND = "";
process.env.PIA_AGY_COMMAND = "";
// 不带开发机的模型服务商凭据：Pi 会把设了这些变量的服务商算作「已配置」，测试结果跟着开发机变，也不能有误碰真实付费模型的可能（和 e2e/fixtures/temp-server.mjs 的 withoutCredentials 同一口径）。
for (const k of Object.keys(process.env)) if (/(_API_KEY|_TOKEN|_SECRET_ACCESS_KEY)$|^(ANTHROPIC|AWS|AZURE|GOOGLE|GCLOUD)_/.test(k)) delete process.env[k];
// 单测绝不碰真实钥匙串：PATH 最前面放一个假的 security（一律「没有这一项」，写入也失败 → 主密钥落在临时数据目录的 master.key）。
// 子进程继承 PATH，所以测试里直接起的服务也一样。2026-10-19 在 Mac 上发现 secrets / server-setup 测试会读到真实 App 的主密钥。
const fakeBin = join(dataDir, "fake-bin");
mkdirSync(fakeBin, { recursive: true });
writeFileSync(join(fakeBin, "security"), "#!/bin/sh\nexit 44\n", { mode: 0o755 });
process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH ?? ""}`;

/** 供测试断言：单测的数据目录必须是临时目录（fail-closed，防止以后再退回真实数据目录）。 */
export const TEST_DATA_DIR = resolve(dataDir);

/**
 * `dir` 是否真的落在系统临时目录里（fail-closed）。
 *
 * 用 realpath + 路径分隔符边界判断，而不是裸 `startsWith(resolve(tmpdir()))`：后者会把 `/tmpfoo`、
 * `/tmp-evil` 误判为临时目录；`realpath` 顺带拒绝「位于临时目录里的 symlink 指向别处」的外跳。
 * 解析失败（路径不存在 / 无权限）→ false。
 */
export const isTempDataDir = (dir: string) => {
	try {
		const tmpReal = realpathSync(tmpdir());
		const real = realpathSync(dir);
		return real === tmpReal || real.startsWith(tmpReal + sep);
	} catch {
		return false;
	}
};
