// 按 third-party.json 固定的版本下载 cua-driver（MIT）官方发布包并校验 SHA256。
// 用法：node scripts/fetch-cua-driver.mjs <linux-x64|linux-arm64|darwin|win-x64> <输出目录>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [target = "linux-x64", out = "packages/sandbox-desktop/vendor"] = process.argv.slice(2);
const c = JSON.parse(readFileSync(new URL("../third-party.json", import.meta.url))).components.find((x) => x.name === "cua-driver");
const asset = c.assets[target].replaceAll("{v}", c.version);
const base = `https://github.com/${c.repo}/releases/download/${c.tagPrefix}${c.version}`;
const get = async (u) => {
	const r = await fetch(u);
	if (!r.ok) throw new Error(`${r.status} ${u}`);
	return Buffer.from(await r.arrayBuffer());
};
mkdirSync(out, { recursive: true });
const sums = (await get(`${base}/${c.checksums}`)).toString();
const want = sums.split("\n").find((l) => l.trim().endsWith(asset))?.split(/\s+/)[0];
const buf = await get(`${base}/${asset}`);
const got = createHash("sha256").update(buf).digest("hex");
if (!want || want !== got) throw new Error(`SHA256 不匹配：${asset} 期望 ${want} 实际 ${got}`);
const file = join(out, asset);
writeFileSync(file, buf);
if (asset.endsWith(".tar.gz")) execFileSync("tar", ["xzf", file, "-C", out, "cua-driver"]);
console.log(`cua-driver ${c.version} (${target}) → ${out}  sha256 ok`);
