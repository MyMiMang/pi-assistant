/**
 * 助理电脑虚拟机资源（CPU / 内存 / 磁盘）：建议值、可调范围、校验，以及“关机后生效”的合并规则。
 * 纯逻辑，单测覆盖；不在这里碰真实虚拟机。
 *
 * 规则：
 * - 用户没设的字段：已有虚拟机保留现有值（不强行升级 / 降配），新建的按这台机器的建议值。
 * - 读宿主 CPU / 总内存只用来给建议和收窄上限（内存上限取总内存的 75%），不把“总内存”当成可用内存夸口。
 * - 磁盘只扩不缩：用户填得比现有小就用现有值，绝不静默重建（数据会丢）。
 */
import { cpus, totalmem } from "node:os";

const GiB = 1024 ** 3;
export interface VmResources {
	cpus: number;
	memoryGiB: number;
	diskGiB: number;
}
/** 用户选择的资源；只填想改的字段，其余留空用现有值 / 建议值 */
export interface VmResourceChoice {
	cpus?: number;
	memoryGiB?: number;
	diskGiB?: number;
}
export interface HostFacts {
	ncpu: number;
	totalBytes: number;
}
/** 硬边界（再按这台机器的实际资源收窄） */
export const RESOURCE_LIMITS = {
	minCpus: 1,
	maxCpus: 16,
	minMemoryGiB: 2,
	maxMemoryGiB: 32,
	minDiskGiB: 20,
	maxDiskGiB: 256,
} as const;
const FIELD_LABEL: Record<keyof VmResources, string> = { cpus: "CPU 核数", memoryGiB: "内存（GiB）", diskGiB: "磁盘（GiB）" };

export function hostFacts(ncpu = cpus().length, totalBytes = totalmem()): HostFacts {
	return { ncpu: Math.max(1, Number.isFinite(ncpu) ? ncpu : 1), totalBytes: Math.max(GiB, Number.isFinite(totalBytes) ? totalBytes : GiB) };
}

/** 这台机器的建议值：CPU 留 2 核给宿主（2–4），内存给一半（4–8 GiB），磁盘 40 GiB（稀疏分配，用多少占多少） */
export function suggestResources(host: HostFacts = hostFacts()): VmResources {
	const halfMem = Math.floor(host.totalBytes / GiB / 2);
	return { cpus: Math.min(4, Math.max(2, host.ncpu - 2)), memoryGiB: Math.min(8, Math.max(4, halfMem)), diskGiB: 40 };
}

/** 可调范围：按这台机器收窄上限（内存最多总内存的 75%），不超配宿主 */
export function resourceBounds(host: HostFacts = hostFacts()) {
	const memCap = Math.min(RESOURCE_LIMITS.maxMemoryGiB, Math.max(RESOURCE_LIMITS.minMemoryGiB, Math.floor((host.totalBytes / GiB) * 0.75)));
	return {
		cpus: { min: RESOURCE_LIMITS.minCpus, max: Math.min(RESOURCE_LIMITS.maxCpus, Math.max(RESOURCE_LIMITS.minCpus, host.ncpu)) },
		memoryGiB: { min: RESOURCE_LIMITS.minMemoryGiB, max: memCap },
		diskGiB: { min: RESOURCE_LIMITS.minDiskGiB, max: RESOURCE_LIMITS.maxDiskGiB },
	};
}

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

/** 校验用户输入：只收整数、必须在范围内（API 直接拒非法值，不给 shell 注入留口子）。
 *  existing：现有虚拟机的实际值。换机器 / 旧环境变量可能让现值超出按当前宿主收窄后的上限，
 *  这种情况「保留现值」不算调大，放行；想调得比现值更大仍按上限拒。 */
export function validateResourceChoice(input: unknown, host: HostFacts = hostFacts(), existing: Partial<VmResources> | null = null): { ok: true; value: VmResourceChoice } | { ok: false; error: string } {
	if (input === undefined || input === null) return { ok: true, value: {} };
	if (typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "资源设置格式不正确" };
	const b = resourceBounds(host);
	const o = input as Record<string, unknown>;
	const out: VmResourceChoice = {};
	for (const key of ["cpus", "memoryGiB", "diskGiB"] as const) {
		const v = o[key];
		if (v === undefined || v === null) continue;
		if (!isInt(v)) return { ok: false, error: `${FIELD_LABEL[key]}要填整数` };
		if (v < b[key].min || v > b[key].max) {
			if (existing?.[key] !== v) return { ok: false, error: `${FIELD_LABEL[key]}要在 ${b[key].min}–${b[key].max} 之间` };
		}
		out[key] = v;
	}
	return { ok: true, value: out };
}

/** 用户选择叠加到建议值（越界按上限 / 下限收窄，绝不超配宿主） */
export function resolveResources(choice: VmResourceChoice = {}, host: HostFacts = hostFacts()): VmResources {
	const s = suggestResources(host);
	const b = resourceBounds(host);
	const pick = (k: keyof VmResources) => {
		const v = choice[k];
		if (v === undefined) return s[k];
		return Math.min(Math.max(v, b[k].min), b[k].max);
	};
	return { cpus: pick("cpus"), memoryGiB: pick("memoryGiB"), diskGiB: pick("diskGiB") };
}

export interface MergedResources extends VmResources {
	/** 用户 / 现有磁盘比请求的大，按现有保留（只扩不缩） */
	diskKeptLarger?: boolean;
}
/**
 * 关机后写配置时用：用户显式设置 > 现有虚拟机值（尊重现值）> 建议值；磁盘只扩不缩。
 * existing 来自现有实例的 lima.yaml（可能没有）。
 */
export function mergeInstanceResources(choice: VmResourceChoice = {}, existing: Partial<VmResources> | null = null, host: HostFacts = hostFacts()): MergedResources {
	const resolved = resolveResources(choice, host);
	const use = (k: keyof VmResources): number => (choice[k] !== undefined ? resolved[k] : existing?.[k] !== undefined ? (existing[k] as number) : resolved[k]);
	const out: MergedResources = { cpus: use("cpus"), memoryGiB: use("memoryGiB"), diskGiB: use("diskGiB") };
	if (existing?.diskGiB !== undefined && out.diskGiB < existing.diskGiB) {
		out.diskGiB = existing.diskGiB;
		out.diskKeptLarger = true;
	}
	return out;
}

/** 用户选的磁盘比现有虚拟机小 → 返回中文错误（只扩不缩，避免重建丢数据）；没现有值 / 没设磁盘则返回 null */
export function checkDiskGrowOnly(choice: VmResourceChoice, existing: Partial<VmResources> | null): string | null {
	if (choice.diskGiB === undefined || existing?.diskGiB === undefined) return null;
	if (choice.diskGiB < existing.diskGiB) return `磁盘只能扩大，不能缩小（现在是 ${existing.diskGiB} GiB，要缩小只能删除虚拟机重装，里面的登录状态会丢）`;
	return null;
}
