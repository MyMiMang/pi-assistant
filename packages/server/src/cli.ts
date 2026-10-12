/**
 * 服务器版命令行（由 /usr/local/bin/pi-assistant 包装调用，环境变量与服务相同：PIA_DATA_DIR 等）。
 *   setup-code    显示当前的一次性设置码（还没有主人设备时）
 *   reset-owner   取消所有主人设备（吊销它们），服务会生成新的设置码——主人设备丢了时用
 *   devices       列出已配对设备
 */
import { existsSync, readFileSync } from "node:fs";
import { hasOwner, listDevices, resetOwners } from "./auth.ts";
import { setupCodeFile } from "./setup-code.ts";

const cmd = process.argv[2];
if (cmd === "setup-code") {
	if (hasOwner()) console.log("已经设置过主人设备，不需要设置码。主人设备丢了：pi-assistant reset-owner");
	else if (existsSync(setupCodeFile())) console.log(`设置码：${readFileSync(setupCodeFile(), "utf8").trim()}`);
	else console.log("还没有生成设置码：确认服务在运行（pi-assistant status），服务启动后会自动生成");
} else if (cmd === "reset-owner") {
	const n = resetOwners();
	console.log(`已取消 ${n} 台主人设备。服务会在一分钟内生成新的设置码（pi-assistant setup-code 查看）`);
} else if (cmd === "devices") {
	for (const d of listDevices() as { id: string; name: string; status: string; owner: number; last_ip: string | null }[]) console.log(`${d.owner ? "★ 主人" : "  设备"}  ${d.name}  ${d.status}  ${d.last_ip ?? ""}  ${d.id}`);
} else {
	console.log("用法：pi-assistant-cli setup-code | reset-owner | devices");
	process.exit(cmd ? 1 : 0);
}
process.exit(0);
