/** e2e 截图/证据输出目录：默认写仓库内被 gitignore 的 artifacts/，SHOT_DIR 可覆盖；不再写进 docs/ 或 evidence/。 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
export const artifactDir = (name = "screenshots") => {
	const dir = process.env.SHOT_DIR ?? join(root, "artifacts", name);
	mkdirSync(dir, { recursive: true });
	return dir;
};
