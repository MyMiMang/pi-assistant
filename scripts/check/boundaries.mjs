// 依赖边界：Pi 只经 pi-adapter；Hindsight 只经 memory/hindsight；前端不用原生 select、不重复定义 ui.tsx 的基础组件；不改 Pi 版本基线。
import { read, exists } from "./lib.mjs";

const UI_BASE = ["Button", "Modal", "Help", "Fold", "Select", "Badge", "Avatar", "ErrorBox", "Input", "useConfirm"];
export function checkBoundaries(files, baseline) {
	const errors = [], next = { nativeSelect: {} };
	for (const f of files) {
		if (!/\.(ts|tsx|mjs|js)$/.test(f)) continue;
		const src = read(f);
		// 1. 服务端只在 pi-adapter 里直接用 Pi SDK（ext-* 是 Pi 扩展，可以用公开扩展 API）
		if (f.startsWith("packages/server/src/") && !f.startsWith("packages/server/src/pi-adapter/") && /from\s+["']@earendil-works\//.test(src) && !baseline.piImportAllow.includes(f))
			errors.push(`${f}：直接 import 了 Pi SDK。Pi 只能经 packages/server/src/pi-adapter/ 使用（见 docs/decisions/0002）`);
		// 2. Hindsight 的 HTTP 接口只在 memory/hindsight 里调
		if (/^(packages|apps)\/[^/]+\/src\//.test(f) && !f.startsWith("packages/server/src/memory/hindsight/") && /\/v1\/default\/banks/.test(src))
			errors.push(`${f}：直接调用 Hindsight 接口。只能经 packages/server/src/memory/hindsight/（见 docs/decisions/0003）`);
		if (f.startsWith("apps/web/src/") && f !== "apps/web/src/components/ui.tsx") {
			// 3. 原生 <select>：用 ui.tsx 的 <Select>。老用法记在基线里，只许减少
			const n = (src.match(/<select[\s>]/g) ?? []).length;
			const max = baseline.nativeSelect[f] ?? 0;
			if (n > max) errors.push(`${f}：用了原生 <select>（${n} 处，基线 ${max}）。请改用 ui.tsx 的 <Select>`);
			if (n) next.nativeSelect[f] = Math.min(n, max || n);
			// 4. 不在 ui.tsx 以外重复定义基础组件
			for (const name of UI_BASE)
				if (new RegExp(`^(export\\s+)?(function|const)\\s+${name}\\b`, "m").test(src)) errors.push(`${f}：又定义了一个 ${name}。基础组件只在 apps/web/src/components/ui.tsx，直接复用`);
		}
	}
	// 5. node_modules 不能入库；Pi 版本必须与兼容基线一致（开发时手动跑 scripts/pi-update.mjs 升级）
	if (files.some((f) => f.startsWith("node_modules/") || f.includes("/node_modules/"))) errors.push("node_modules 里的文件进了仓库：不改、不提交 node_modules");
	const compat = JSON.parse(read("packages/server/src/pi-adapter/compat.json"));
	const ok = [compat.testedWith, compat.target].filter(Boolean);
	const deps = JSON.parse(read("packages/server/package.json")).dependencies ?? {};
	for (const [name, v] of Object.entries(deps))
		if (name.startsWith("@earendil-works/") && !ok.includes(v)) errors.push(`packages/server/package.json：${name}@${v} 与 pi-adapter/compat.json（${ok.join(" / ")}）不一致。Pi 升级只走 scripts/pi-update.mjs`);
	return { errors, next };
}
export const hasFile = exists;
