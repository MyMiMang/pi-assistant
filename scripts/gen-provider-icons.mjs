#!/usr/bin/env node
/**
 * 生成内置模型服务的品牌图标：`apps/web/src/components/provider-icons.ts`。
 *
 * 图标来自 npm 包 @lobehub/icons-static-svg（MIT，https://github.com/lobehub/lobe-icons），
 * 只提取下面 ICON_BY_PROVIDER 用到的服务，编译进网页；没有条目的服务（自定义渠道、未收录品牌）用字母头像兜底。
 * 许可记录见 THIRD_PARTY_NOTICES.md。
 *
 * 用法（需要先 npm ci，安装根 devDependency @lobehub/icons-static-svg）：
 *   node scripts/gen-provider-icons.mjs
 *   node scripts/gen-provider-icons.mjs --check   # 只校验已生成文件是否最新（CI 用）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "apps/web/src/components/provider-icons.ts");

/** provider id（Pi 模型目录里的 key）→ @lobehub/icons-static-svg 的图标名（不含 -color / .svg）。
 *  同一品牌的多个渠道（如 moonshotai / moonshotai-cn）共用一张图。 */
const ICON_BY_PROVIDER = {
	"amazon-bedrock": "aws",
	"ant-ling": "antgroup",
	anthropic: "anthropic",
	azure: "azure",
	baseten: "baseten",
	cerebras: "cerebras",
	"cloudflare-ai-gateway": "cloudflare",
	"cloudflare-workers-ai": "cloudflare",
	deepseek: "deepseek",
	fireworks: "fireworks",
	"github-copilot": "githubcopilot",
	google: "google",
	"google-vertex": "googlecloud",
	groq: "groq",
	huggingface: "huggingface",
	"kimi-coding": "kimi",
	meta: "meta",
	minimax: "minimax",
	"minimax-cn": "minimax",
	mistral: "mistral",
	moonshotai: "moonshot",
	"moonshotai-cn": "moonshot",
	nvidia: "nvidia",
	openai: "openai",
	"openai-codex": "openai",
	opencode: "opencode",
	"opencode-go": "opencode",
	openrouter: "openrouter",
	"qwen-token-plan": "qwen",
	"qwen-token-plan-cn": "qwen",
	"qwen-token-plan-individual": "qwen",
	together: "together",
	"vercel-ai-gateway": "vercel",
	xai: "xai",
	xiaomi: "xiaomimimo",
	"xiaomi-token-plan-ams": "xiaomimimo",
	"xiaomi-token-plan-cn": "xiaomimimo",
	"xiaomi-token-plan-sgp": "xiaomimimo",
	zai: "zhipu",
	"zai-coding-cn": "zhipu",
};

const iconsDir = join(dirname(require.resolve("@lobehub/icons-static-svg/package.json", { paths: [root] })), "icons");

/** 读一个图标：优先彩色版（品牌色），没有就退回单色版（currentColor，跟随明暗主题）。 */
function readIcon(name) {
	for (const file of [`${name}-color.svg`, `${name}.svg`]) {
		try {
			return { file, svg: readFileSync(join(iconsDir, file), "utf8") };
		} catch {}
	}
	throw new Error(`@lobehub/icons-static-svg 里找不到图标：${name}（${iconsDir}）`);
}

/** 规整 SVG：去掉固定 1em 尺寸和行内 style，让外层容器控制大小；其余（viewBox / fill / title）原样保留。 */
function normalize(svg) {
	return svg
		.replace(/\s*style="[^"]*"/g, "")
		.replace(/height="1em"/g, 'height="100%"')
		.replace(/width="1em"/g, 'width="100%"')
		.replace(/\s*\n\s*/g, "")
		.trim();
}

const entries = Object.entries(ICON_BY_PROVIDER)
	.map(([id, name]) => [id, normalize(readIcon(name).svg)])
	.sort(([a], [b]) => a.localeCompare(b));

const body = `/**
 * 自动生成，请勿手改 —— 运行 \`node scripts/gen-provider-icons.mjs\` 重新生成。
 *
 * 内置模型服务的品牌图标，来自 @lobehub/icons-static-svg（MIT，https://github.com/lobehub/lobe-icons），
 * 许可记录见 THIRD_PARTY_NOTICES.md。key 是 Pi 模型目录里的 provider id；
 * 没有条目的服务（自定义渠道、未收录品牌）在界面上用字母头像兜底。
 */
export const PROVIDER_ICONS: Record<string, string> = {
${entries.map(([id, svg]) => `\t${JSON.stringify(id)}: ${JSON.stringify(svg)},`).join("\n")}
};
`;

if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(OUT, "utf8");
	} catch {}
	if (current !== body) {
		console.error("provider-icons.ts 不是最新的，请运行 node scripts/gen-provider-icons.mjs");
		process.exit(1);
	}
	console.log(`provider-icons.ts 已是最新（${entries.length} 个服务）`);
} else {
	writeFileSync(OUT, body);
	console.log(`已写入 ${OUT}（${entries.length} 个服务）`);
}
