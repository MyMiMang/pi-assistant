/**
 * 本地 SenseVoice 的平台判定与 CPU 线程上限（纯函数，可单测）。
 *
 * 事实边界（`research/sensevoice-local-asr-feasibility.md` §3.2）：
 *  - 引擎 sherpa-onnx 是 **CPU** 路径；官方有 `--provider coreml` 开关，但**没有 SenseVoice + CoreML/Metal
 *    的支持声明或基准** → **不虚构 GPU 加速**，一律按 CPU 规划。
 *  - 平台可用性以 **PyPI 官方轮子**为准（`sherpa-onnx==1.13.8`，本次复核）：
 *    `macosx_11_0_arm64` / `macosx_10_15_x86_64` / `win_amd64` / `manylinux2014_x86_64` / `manylinux2014_aarch64`。
 *  - 线程数按**物理核**封顶，不霸占全部 CPU（用户要求：`限 physical cores，不霸全 CPU`）。
 */

export type AsrSupport = "supported" | "conditional" | "unsupported";

export interface AsrPlatformProfile {
	/** `${platform}-${arch}`，如 `darwin-arm64` */
	key: string;
	os: string;
	arch: string;
	support: AsrSupport;
	/** 加速器：**只有 cpu**（不虚构 MPS / CoreML；上游未证） */
	accelerator: "cpu";
	/** 官方轮子标签（供界面「来源」显示；unsupported 时为 null） */
	wheelTag: string | null;
	/** 面向用户的中文说明 */
	reason: string;
}

/** 依据「平台 + 架构」给出默认 profile；不支持的组合 `support=unsupported`，绝不用假 no-op 冒充。 */
export function senseVoicePlatform(platform: string = process.platform, arch: string = process.arch): AsrPlatformProfile {
	const key = `${platform}-${arch}`;
	const base = (p: Omit<AsrPlatformProfile, "key" | "os" | "arch">): AsrPlatformProfile => ({ key, os: platform, arch, ...p });

	if (platform === "darwin") {
		if (arch === "arm64")
			return base({
				support: "supported",
				accelerator: "cpu",
				wheelTag: "macosx_11_0_arm64",
				reason: "Apple Silicon：CPU 推理（官方未证 SenseVoice 的 CoreML/Metal 加速，不启用）",
			});
		if (arch === "x64")
			return base({
				support: "supported",
				accelerator: "cpu",
				wheelTag: "macosx_10_15_x86_64",
				reason: "Intel Mac：CPU 推理，官方有 x86_64 轮子",
			});
		return base({ support: "unsupported", accelerator: "cpu", wheelTag: null, reason: `暂不支持 ${key}` });
	}
	if (platform === "win32") {
		if (arch === "x64") return base({ support: "supported", accelerator: "cpu", wheelTag: "win_amd64", reason: "Windows x64：CPU 推理" });
		// win_arm64 轮子存在（cp311+），但未实测，按条件支持。
		if (arch === "arm64")
			return base({ support: "conditional", accelerator: "cpu", wheelTag: "win_arm64", reason: "Windows ARM64：有官方轮子但未实测，按条件支持" });
		return base({ support: "unsupported", accelerator: "cpu", wheelTag: null, reason: `暂不支持 ${key}` });
	}
	if (platform === "linux") {
		if (arch === "x64") return base({ support: "supported", accelerator: "cpu", wheelTag: "manylinux2014_x86_64", reason: "Linux x64：CPU 推理" });
		if (arch === "arm64") return base({ support: "supported", accelerator: "cpu", wheelTag: "manylinux2014_aarch64", reason: "Linux ARM64：CPU 推理" });
		return base({ support: "unsupported", accelerator: "cpu", wheelTag: null, reason: `暂不支持 ${key}` });
	}
	return base({ support: "unsupported", accelerator: "cpu", wheelTag: null, reason: `暂不支持 ${key}` });
}

/**
 * CPU 线程上限：取**物理核**，再夹到 [1, max]。
 * 拿不到物理核数时退回 `logical / 2`（超线程经验值），再不行按 4 —— **宁可保守，不霸全 CPU**。
 */
export function capThreads(physicalCores: number | null | undefined, opts: { logicalCores?: number | null; max?: number } = {}): number {
	const max = Math.max(1, opts.max ?? 8);
	let n = physicalCores && physicalCores > 0 ? physicalCores : 0;
	if (!n) {
		const logical = opts.logicalCores && opts.logicalCores > 0 ? opts.logicalCores : 0;
		n = logical ? Math.max(1, Math.floor(logical / 2)) : 4;
	}
	return Math.max(1, Math.min(max, Math.floor(n)));
}

/** 运行 sidecar 时的线程参数（sherpa-onnx `--num-threads`）。 */
export function threadsArg(n: number): string[] {
	return ["--num-threads", String(Math.max(1, Math.floor(n)))];
}
