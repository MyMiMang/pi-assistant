// 每个测试进程使用独立的临时数据目录（必须在导入 config 之前设置）
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.HUHAO_DATA_DIR ??= mkdtempSync(join(tmpdir(), "huhao-test-"));
process.env.HUHAO_OFFLINE = "1";
