/**
 * 本地 Laya 的平台判定与加速器选择（纯函数，可单测）。
 *
 * 依据 docs/research 里的可行性调研（`research/laya-one-click-cross-platform-feasibility.md`）：
 *  - 「PyTorch 支持某设备」≠「Laya 支持」；Laya 的设备顺序是 CUDA → MPS → XPU → CPU，不存在的设备静默退回 CPU。
 *  - 不做「一套 bundle 覆盖所有 GPU」。AMD 不承诺 GPU（DirectML 已废弃）；Windows ARM64 无 torch 轮子，预检直接标记不支持。
 *  - 实际用的设备必须以运行时 `/health` 为准（这里是安装时的**意图/能力预检**，不是已实测结论）。
 */

/** 安装时选择的加速器（意图）。实际生效的设备看运行时 `/health`。 */
export type LayaAccelerator = "cpu" | "mps" | "cuda" | "xpu";

/** 支持级别：supported=承诺可用；conditional=能跑但要 pin 老栈/额外条件；experimental=未在 Laya 侧验证；unsupported=不做。 */
export type LayaSupport = "supported" | "conditional" | "experimental" | "unsupported";

export interface PlatformProfile {
	/** `${platform}-${arch}`，如 `darwin-arm64` */
	key: string;
	os: string;
	arch: string;
	/** 默认选中的加速器（CUDA/XPU 需用户在 preflight 里显式开启才会变） */
	accelerator: LayaAccelerator;
	support: LayaSupport;
	/** torch 后端索引：cpu / cu130 / xpu；macOS arm64 用 pypi 默认（arm64 轮子） */
	torchBackend: "default" | "cpu" | "cu130" | "xpu";
	/** 额外 pip pin（Intel Mac 需要 numpy<2 + torch==2.2.2 + transformers==4.57.6） */
	pins: string[];
	/** 面向用户的一句话说明（中文） */
	reason: string;
}

/** NVIDIA 驱动检查结果（只看驱动，不自动安装系统驱动）。 */
export interface NvidiaProbe {
	available: boolean;
	driver: string | null;
	cuda: string | null;
}

export interface PlatformContext {
	/** 是否检测到 NVIDIA 驱动（CUDA 可选的前提） */
	nvidia?: NvidiaProbe;
	/** 用户是否显式请求 CUDA（默认关，不借完整权限自动装驱动） */
	wantCuda?: boolean;
	/** 用户是否显式请求 Intel XPU（experimental） */
	wantXpu?: boolean;
	/** 是否检测到 Intel XPU / oneAPI（可选，拿不到就按未证处理） */
	xpu?: boolean;
}

/**
 * 依据「平台 + 架构」给出默认 profile。**平台/架构不被支持时 support=unsupported，绝不用假 no-op 冒充实现了跨平台。**
 * CUDA / XPU 只有在 `ctx` 里显式请求（且满足前置条件）时才切换；否则一律 CPU 基线。
 */
export function platformProfile(platform: string = process.platform, arch: string = process.arch, ctx: PlatformContext = {}): PlatformProfile {
	const key = `${platform}-${arch}`;
	const mac = platform === "darwin";
	const win = platform === "win32";
	const linux = platform === "linux";

	// ---- 硬不支持：Windows ARM64（PyPI 无 win_arm64 torch 轮子）----
	if (win && arch === "arm64") {
		return base(key, platform, arch, {
			accelerator: "cpu",
			support: "unsupported",
			torchBackend: "cpu",
			reason: "Windows ARM64 没有可用的 PyTorch 轮子，暂不支持",
		});
	}

	// ---- macOS ----
	if (mac) {
		if (arch === "arm64") {
			// Apple Silicon：MPS 是原生路径，但实际是否用上要读 /health。
			return base(key, platform, arch, {
				accelerator: "mps",
				support: "supported",
				torchBackend: "default",
				reason: "Apple Silicon：默认走 MPS（实际设备以运行时 /health 为准）",
			});
		}
		// Intel Mac：CPU only，且必须 pin 老栈（torch 2.3+ 不再发 macOS x86_64 轮子）。
		return base(key, platform, arch, {
			accelerator: "cpu",
			support: "conditional",
			torchBackend: "default",
			pins: ["numpy<2", "torch==2.2.2", "transformers==4.57.6"],
			reason: "Intel Mac：仅 CPU，需要锁定旧版 torch / transformers / numpy",
		});
	}

	// ---- Windows / Linux（x64 与 Linux arm64）----
	// Windows x86_64 才谈 CUDA / XPU；Linux x86_64 谈 CUDA / XPU /（ROCm 未证）。
	if (arch === "arm64" && linux) {
		// Linux ARM64：CPU 轮子存在；DGX Spark 类 CUDA 官方未报实测，按条件支持，默认 CPU。
		return base(key, platform, arch, {
			accelerator: "cpu",
			support: "conditional",
			torchBackend: "cpu",
			reason: "Linux ARM64：CPU 可用；CUDA 官方未报实测，暂不默认开启",
		});
	}
	if ((win || linux) && arch === "x64") {
		// 默认 CPU 基线。
		let accelerator: LayaAccelerator = "cpu";
		let torchBackend: PlatformProfile["torchBackend"] = "cpu";
		let support: LayaSupport = "supported";
		let reason = "x64：CPU 基线可用";
		const nvidiaOk = !!ctx.wantCuda && !!ctx.nvidia?.available;
		if (nvidiaOk) {
			accelerator = "cuda";
			torchBackend = "cu130";
			reason = `x64：CPU 基线 + NVIDIA CUDA（驱动 ${ctx.nvidia?.driver ?? "已检测到"}，可选）`;
		} else if (ctx.wantXpu && ctx.xpu) {
			// Intel XPU：experimental，未在 Laya 侧验证。
			accelerator = "xpu";
			torchBackend = "xpu";
			support = "experimental";
			reason = "x64：Intel XPU 为实验性，需要厂商驱动 + 专用轮子，未在本机验证";
		} else if (ctx.wantCuda) {
			reason = "x64：请求了 CUDA 但未检测到可用的 NVIDIA 驱动，按 CPU 安装";
		}
		return base(key, platform, arch, { accelerator, support, torchBackend, reason });
	}

	// ---- 其他架构（如 linux arm 未列、darwin 未列）一律不支持，哪怕当下用不到。----
	return base(key, platform, arch, {
		accelerator: "cpu",
		support: "unsupported",
		torchBackend: "cpu",
		reason: `暂不支持 ${key}`,
	});
}

function base(key: string, os: string, arch: string, p: Omit<PlatformProfile, "key" | "os" | "arch" | "pins"> & { pins?: string[] }): PlatformProfile {
	return { key, os, arch, pins: p.pins ?? [], accelerator: p.accelerator, support: p.support, torchBackend: p.torchBackend, reason: p.reason };
}

/** 把 torch 后端转成 uv/pip 的 `--torch-backend` 参数值。 */
export function torchBackendArg(p: PlatformProfile): string {
	return p.torchBackend === "default" ? "auto" : p.torchBackend;
}
