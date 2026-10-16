/**
 * 权重许可门槛（纯函数，可单测）。
 *
 * 用户要求（原话大意）：SenseVoice 等模型要**留在列表里、像其他模型一样一键下载安装使用**；
 * 不随 App bundle 权重、不 mirror / 不代分发；许可适用范围（商用 / 再分发）未最终确认时**如实标注**，
 * 但不能因此把「用户本人在自己电脑上按需下载自用」的入口一刀切关掉。
 *
 * 因此许可结论分两个独立维度（都是数据，见 manifest.ts）：
 *  - `selfServe`：本地按需下载安装（用户自用）是否放行 —— 决定安装入口 / 目录 available / 下载面板；
 *  - `decision` + `redistribution`：整体结论、是否允许随 App 分发 / 镜像 —— 决定能否 bundle、界面标签。
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
 *  - `selfServe === false`：拒绝（本地自用下载安装未放行）；
 *  - `selfServe === true`：放行；**只有上游确实要求显式同意时**（`requiresExplicitAgreement`）才校验
 *    `acceptLicense === termsVersion`，否则一键装（正常展示署名与许可证链接即可）。
 *
 * 注意：不再有 `allowUnresolved` 之类的 override 后门；SenseVoice 的放行由 `selfServe` 数据决定，
 * 与「是否 cleared / unresolved」无关（整体 unresolved 只影响分发与界面标注）。
 */
export function installGate(license: AsrLicenseMeta, acceptLicense?: string | null): GateResult {
	if (license.decision === "prohibited" || !license.selfServe) {
		return { allowed: false, reason: `权重许可（${license.licenseName}）不允许本地下载安装：${license.reason}` };
	}
	if (license.requiresExplicitAgreement === true) {
		if (!acceptLicense) return { allowed: false, reason: `安装前必须接受许可条款 ${license.termsVersion}（acceptLicense 缺失）` };
		if (acceptLicense !== license.termsVersion) return { allowed: false, reason: `许可条款版本不匹配（需要 ${license.termsVersion}，收到 ${acceptLicense}）` };
	}
	return { allowed: true };
}

/** 自行导入门槛：只禁「明确禁止」；整体 unresolved 下用户导入自己合法取得的权重仍开放。 */
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
	/** 本地按需下载安装是否放行（安装按钮 / 下载面板按它显示，不再看 decision） */
	selfServe: boolean;
	redistribution: boolean;
	attribution: string;
	/** 是否必须显式确认条款（上游没要求的一律 false → 一键装，只需展示署名与链接） */
	agreementRequired: boolean;
	links: AsrLicenseMeta["links"];
	restrictions: string[];
	reason: string;
	/** 需要确认时用户必须原样回传的接受值（安装时）；不需要确认的模型可忽略 */
	acceptValue: string;
}

export function licenseDisclosure(license: AsrLicenseMeta): LicenseDisclosure {
	return {
		licenseName: license.licenseName,
		termsVersion: license.termsVersion,
		decision: license.decision,
		selfServe: license.selfServe,
		redistribution: license.redistribution,
		attribution: license.attribution,
		agreementRequired: license.requiresExplicitAgreement === true,
		links: { ...license.links },
		restrictions: [...license.restrictions],
		reason: license.reason,
		acceptValue: license.termsVersion,
	};
}
