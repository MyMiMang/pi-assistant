/** 临时假 Amp runtime 元数据与普通文件；绝不执行产物或访问外网。 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NativeRelease } from "../../src/cli-agents/native-install.ts";

export function fakeAmpRuntime(dataDir: string, release: NativeRelease): string {
 const root = join(dataDir, "runtimes", "amp", "cli-agents", "amp-acp");
 const dir = join(root, release.version);
 const platform = `${process.platform}-${process.arch}`;
 const asset = release.assets![platform] ?? { url: "https://official.test/offline-amp", sha256: "0".repeat(64), archive: "raw", entry: "amp" };
 const entry = asset.entry;
 mkdirSync(dir, { recursive: true });
 writeFileSync(join(dir, entry), "offline fake runtime; never executed");
 writeFileSync(join(dir, ".pia-installed.json"), JSON.stringify({ ...release, packageName: "amp-cli-runtime", assets: { ...release.assets, [platform]: asset }, verified: false }));
 writeFileSync(join(root, "current.json"), JSON.stringify({ version: release.version }));
 return join(dir, entry);
}
