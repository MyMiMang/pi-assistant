// Pi Assistant 不使用 openclaw.json：账号配置保存在我们自己的加密存储里。插件想改配置时什么都不做。
export async function mutateConfigFile() {
	return { changed: false };
}
