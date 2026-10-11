import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// 插件日志 / 临时文件目录：放在我们数据目录里的状态目录下（服务端启动时设置 OPENCLAW_STATE_DIR）
export function resolvePreferredOpenClawTmpDir() {
	const base = process.env.OPENCLAW_STATE_DIR ? join(process.env.OPENCLAW_STATE_DIR, "tmp") : join(tmpdir(), "pia-openclaw");
	mkdirSync(base, { recursive: true });
	return base;
}
