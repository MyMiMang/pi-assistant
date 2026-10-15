/**
 * 单测启动前置：**强制**把数据目录指向本次进程专属的临时目录，并关掉外网。
 *
 * 必须用 `=` 覆盖，不能用 `??=`：`??=` 会沿用外部环境里的 PIA_DATA_DIR（例如为了调试真实数据 export 过），
 * 单测于是直接读写用户真实数据目录。2026-10-15 就是这样把 `test/clawbot.test.ts` 里的测试助理
 * 「小微」（id `wa`）连同它的工作区、上传文件和 data.db 一起写进了用户库，侧边栏凭空多出一个助理。
 * 同理 PIA_WORKSPACE 也要一起固定，避免工作区落到别处。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "pia-test-"));
process.env.PIA_DATA_DIR = dataDir;
process.env.PIA_WORKSPACE = join(dataDir, "workspace");
process.env.PIA_OFFLINE = "1";

/** 供测试断言：单测的数据目录必须是临时目录（fail-closed，防止以后再退回真实数据目录）。 */
export const TEST_DATA_DIR = resolve(dataDir);
export const isTempDataDir = (dir: string) => resolve(dir).startsWith(resolve(tmpdir()));
