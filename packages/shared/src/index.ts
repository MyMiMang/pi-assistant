/**
 * 产品品牌：唯一的定义处。正式名字确定前使用中性占位名 “Pi Assistant”。
 * 改名只需要改这里（以及安装包元数据 apps/tray/src-tauri/tauri.conf.json 的 productName/identifier）。
 */
export const BRAND = {
	/** 显示名（UI、通知、PWA 名称） */
	name: "Pi Assistant",
	/** 短名（PWA 主屏图标下方） */
	shortName: "Pi Assistant",
	/** 机器可读 id：数据目录（Linux）、Docker 资源前缀、Worker 名等 */
	id: "pi-assistant",
	/** 数据目录名（macOS / Windows） */
	dataDirName: "Pi Assistant",
	/** 环境变量前缀 */
	envPrefix: "PIA_",
	/** macOS LaunchAgent / 应用标识 */
	bundleId: "com.piassistant.app",
	launchdLabel: "com.piassistant.server",
	/** 一句话定位 */
	tagline: "运行在你自己电脑上的通用 AI 助理：有自己的电脑，能写代码、处理文件、操作网页和桌面应用，替你把事情做完。",
} as const;

/** 旧名字（迁移用）：数据目录、钥匙串服务名、环境变量前缀、浏览器存储键 */
export const LEGACY = { dataDirName: "HuHao", linuxDir: "huhao", keychainService: "HuHao", envPrefix: "HUHAO_", storagePrefix: "huhao.", dbFile: "huhao.db" } as const;
