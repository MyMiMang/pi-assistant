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
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "pia-test-"));
process.env.PIA_DATA_DIR = dataDir;
process.env.PIA_WORKSPACE = join(dataDir, "workspace");
process.env.PIA_OFFLINE = "1";

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
