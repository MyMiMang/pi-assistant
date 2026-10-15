/**
 * 权重许可门槛（纯函数，可单测）。
 *
 * 用户要求（原话大意）：许可适用范围不明确时，**不随 App bundle 权重、不 mirror 再分发**；
 * 安装入口默认 blocked；用户可自行导入合法来源权重；条款限制（企业商用等）必须**默认可见**，
 * 不能靠一次点击遮盖法律文本。
 *
 * 本模块只做判定，不读文件、不发请求、不写状态。
 */
import type { AsrLicenseMeta } from "./manifest.ts";

export interface GateResult {
	allowed: boolean;
	/** 不允许时的中文原因（可直接显示；不含敏感信息） */
	reason?: string;
}

/** 是否允许随 App bundle / 自建镜像再分发权重。`redistribution !== true` 一律 false。 */
export function bundleAllowed(license: AsrLicenseMeta): boolean {
	return license.redistribution === true && license.decision === "cleared";
}

/**
 * 安装（含从官方源直接下载）门槛。
 *  - `decision === "prohibited"`：一律拒绝；
 *  - `decision === "unresolved"`：默认关闭（除非调用方显式传 `allowUnresolved: true`，供「用户已自行了解条款」的高级路径，
 *    产品默认不传）；
 *  - `decision === "cleared"`：允许，但仍要求 `acceptLicense === termsVersion`，防止跳过阅读。
 */
export function installGate(license: AsrLicenseMeta, acceptLicense?: string | null, opts: { allowUnresolved?: boolean } = {}): GateResult {
	if (license.decision === "prohibited") {
		return { allowed: false, reason: `权重许可（${license.licenseName}）不允许安装：${license.reason}` };
	}
	if (license.decision === "unresolved" && !opts.allowUnresolved) {
		return {
			allowed: false,
			reason: `权重许可适用范围未最终确认（${license.licenseName}），安装入口已关闭；可改用「自行导入已合法取得的权重」。依据：${license.links.issue}`,
		};
	}
	if (!acceptLicense) {
		return { allowed: false, reason: `安装前必须接受许可条款 ${license.termsVersion}（acceptLicense 缺失）` };
	}
	if (acceptLicense !== license.termsVersion) {
		return { allowed: false, reason: `许可条款版本不匹配（需要 ${license.termsVersion}，收到 ${acceptLicense}）` };
	}
	return { allowed: true };
}

/** 自行导入门槛：只禁「明确禁止」；`unresolved` 下用户导入自己合法取得的权重仍开放。 */
export function importGate(license: AsrLicenseMeta): GateResult {
	if (license.decision === "prohibited") {
		return { allowed: false, reason: `权重许可（${license.licenseName}）不允许使用：${license.reason}` };
	}
	return { allowed: true };
}

/** 界面「许可」区块的数据（条款正文 / 限制摘要必须默认可见，不是折叠后一次点击）。 */
export interface LicenseDisclosure {
	licenseName: string;
	termsVersion: string;
	decision: AsrLicenseMeta["decision"];
	redistribution: boolean;
	attribution: string;
	links: AsrLicenseMeta["links"];
	restrictions: string[];
	reason: string;
	/** 用户必须原样回传的接受值（安装时） */
	acceptValue: string;
}

export function licenseDisclosure(license: AsrLicenseMeta): LicenseDisclosure {
	return {
		licenseName: license.licenseName,
		termsVersion: license.termsVersion,
		decision: license.decision,
		redistribution: license.redistribution,
		attribution: license.attribution,
		links: { ...license.links },
		restrictions: [...license.restrictions],
		reason: license.reason,
		acceptValue: license.termsVersion,
	};
}
