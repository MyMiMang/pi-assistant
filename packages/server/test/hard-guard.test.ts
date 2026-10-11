/** 硬性保护清单：任何档位都必须明确批准的动作 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { guardComputer, guardPath, guardShell, type GuardContext } from "@pi-assistant/shared";

const H: GuardContext = { target: "host", allowedPaths: ["/data/pia/workspace"], protectedPaths: ["/data/pia", "/Users/d/Library/Application Support/Pi Assistant", "/Applications/Pi Assistant.app"] };
const S: GuardContext = { target: "sandbox" };
const hit = (cmd: string, ctx = H) => guardShell(cmd, ctx)?.rule ?? null;

test("shell：命中", () => {
	const cases: [string, string][] = [
		["sudo shutdown -h now", "power"], ["reboot", "power"], ["shutdown /s /t 0", "power"], ["osascript -e 'tell app \"System Events\" to shut down'", "power"], ["systemctl poweroff", "power"],
		["diskutil eraseDisk APFS X disk2", "disk"], ["mkfs.ext4 /dev/sdb1", "disk"], ["dd if=img of=/dev/disk2 bs=1m", "disk"], ["format C: /q", "disk"], ["diskpart", "disk"],
		[":(){ :|:& };:", "fork-bomb"], ["while true; do sleep 1 & done", "fork-bomb"], ["fallocate -l 500G big", "resource"],
		["networksetup -setairportpower en0 off", "security"], ["sudo pfctl -d", "security"], ["netsh advfirewall set allprofiles state off", "security"], ["dscl . -create /Users/hacker", "security"], ["sudo useradd x", "security"], ["net user admin 123 /add", "security"], ["spctl --master-disable", "security"], ["echo '1.2.3.4 a' | sudo tee -a /etc/hosts", "security"],
		["echo 'alias ls=rm' >> ~/.zshrc", "rc"], ["sed -i 's/a/b/' ~/.bashrc", "rc"], ["cp evil.plist ~/Library/LaunchAgents/", "rc"], ["crontab -r", "autostart"], ["launchctl unload ~/Library/LaunchAgents/com.piassistant.server.plist", "autostart"], ["schtasks /create /tn x /tr y", "autostart"], ["reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v x", "autostart"], ["systemctl --user enable x", "autostart"],
		["pkill -f pi-assistant", "self"], ["killall cloudflared", "self"], ["taskkill /F /IM cua-driver.exe", "self"], ["rm -rf ~/.cache/hindsight", "self"], ["docker rm -f pia-desk-abc", "self"], ["rm -rf '/Users/d/Library/Application Support/Pi Assistant/db'", "self"], ["truncate -s0 /data/pia/pia.db", "self-data"],
		["killall Finder", "system-proc"], ["sudo kill -9 1", "system-proc"], ["kill -9 -1", "system-proc"], ["taskkill /f /im explorer.exe", "system-proc"],
		["sudo rm -rf /usr/local/lib", "system-dir"], ["mv x /System/Library/", "system-dir"], ["del C:\\Windows\\System32\\x.dll", "system-dir"], ["chmod 777 /etc/passwd", "security"], ["sudo cp evil /usr/local/bin/ls", "system-dir"],
		["rm -rf /", "mass-delete"], ["rm -rf ~", "mass-delete"], ["rm -rf *", "mass-delete"], ["rm -rf $DIR/", "mass-delete"], ["rm -fr ~/", "mass-delete"], ["find ~ -name '*.log' -delete", "mass-delete"], ["find / -exec rm {} \\;", "mass-delete"], [`rm ${Array.from({ length: 25 }, (_, i) => `f${i}`).join(" ")}`, "mass-delete"],
		["cd build && rm -rf /", "mass-delete"],
	];
	for (const [c, r] of cases) assert.equal(hit(c), r, c);
});

test("shell：日常命令不命中", () => {
	for (const c of ["ls -la /usr/bin", "/usr/bin/python3 a.py", "cat ~/.zshrc", "rm -rf build", "rm -rf ./node_modules", "rm a.txt b.txt", "git push", "npm install", "kill 12345", "find . -name '*.log' -delete", "cp /usr/share/dict/words ./", "echo hi > out.txt", "docker ps", "grep -r shutdown src/", "crontab -l", "python -c 'print(1)'", "curl https://example.com"])
		assert.equal(hit(c), null, c);
});

test("sandbox：保护助理电脑的运行环境", () => {
	assert.equal(hit("pkill Xvfb", S), "sandbox-runtime");
	assert.equal(hit("killall x11vnc", S), "sandbox-runtime");
	assert.equal(hit("rm -rf /home/agent", S), "mass-delete");
	assert.equal(hit("rm -rf ~/.config/pia-browser", S), "sandbox-runtime");
	assert.equal(hit("pkill chromium", S), null);
	assert.equal(guardComputer("kill_app", { name: "x11vnc" }, S)?.rule, "sandbox-runtime");
	assert.equal(guardComputer("type_text", { text: "pkill websockify\n" }, S)?.rule, "sandbox-runtime");
	assert.equal(guardPath("/home/agent/.config/pia-browser/Default/Cookies", S)?.rule, "sandbox-runtime");
});

test("文件路径", () => {
	assert.equal(guardPath("/Users/d/.zshrc", H)?.rule, "rc");
	assert.equal(guardPath("/Users/d/Library/LaunchAgents/x.plist", H)?.rule, "rc");
	assert.equal(guardPath("/Users/d/Library/Application Support/Pi Assistant/pia.db", H)?.rule, "self-data");
	assert.equal(guardPath("/etc/hosts", H)?.rule, "system-dir");
	assert.equal(guardPath("C:\\Windows\\System32\\drivers\\etc\\hosts", H)?.rule, "system-dir");
	assert.equal(guardPath("/Users/d/work/report.md", H), null);
	assert.equal(guardPath("/data/pia/workspace/a1/report.md", H), null, "工作区在数据目录里，但可以正常写");
	assert.equal(guardPath("/data/pia/pia.db", H)?.rule, "self-data");
	assert.equal(guardShell("rm /data/pia/workspace/a1/old.txt", H), null);
	assert.equal(guardShell("rm /data/pia/pia.db", H)?.rule, "self-data");
	const M: GuardContext = { target: "host", allowedPaths: ["/Users/d/Library/Application Support/Pi Assistant/workspace"], protectedPaths: ["/Users/d/Library/Application Support/Pi Assistant"] };
	assert.equal(guardShell("rm '/Users/d/Library/Application Support/Pi Assistant/workspace/a1/x.txt'", M), null, "工作区路径里带产品名也不算");
	assert.equal(guardShell("rm '/Users/d/Library/Application Support/Pi Assistant/pia.db'", M)?.rule, "self");
	assert.equal(guardPath("/Users/d/Library/Application Support/Pi Assistant2/x", H), null);
});

test("电脑操作", () => {
	assert.equal(guardComputer("kill_app", { name: "Pi Assistant" }, H)?.rule, "self");
	assert.equal(guardComputer("kill_app", { bundle_id: "com.trycua.driver" }, H)?.rule, "self");
	assert.equal(guardComputer("kill_app", { name: "Finder" }, H)?.rule, "system-proc");
	assert.equal(guardComputer("kill_app", { name: "TextEdit" }, H), null);
	assert.equal(guardComputer("launch_app", { bundle_id: "com.apple.systempreferences" }, H)?.rule, "security-app");
	assert.equal(guardComputer("launch_app", { name: "磁盘工具" }, H)?.rule, "security-app");
	assert.equal(guardComputer("launch_app", { launch_path: "C:\\Windows\\regedit.exe" }, H)?.rule, "security-app");
	assert.equal(guardComputer("launch_app", { name: "微信" }, H), null);
	assert.equal(guardComputer("type_text", { text: "sudo rm -rf /\n" }, H)?.rule, "mass-delete");
	assert.equal(guardComputer("type_text", { text: "明天见" }, H), null);
	assert.equal(guardComputer("hotkey", { keys: ["cmd", "option", "esc"] }, H)?.rule, "power");
	assert.equal(guardComputer("hotkey", { keys: ["Command", "Shift", "Q"] }, H)?.rule, "power");
	assert.equal(guardComputer("hotkey", { keys: ["cmd", "c"] }, H), null);
	assert.equal(guardComputer("invoke_menu", { path: ["", "关机…"] }, H)?.rule, "power");
	assert.equal(guardComputer("invoke_menu", { path: ["Apple", "Log Out deng…"] }, H)?.rule, "power");
	assert.equal(guardComputer("click", { element_token: "e3" }, H, ['[e2] AXButton "取消"\n[e3] AXButton "抹掉"'])?.rule, "power");
	assert.equal(guardComputer("click", { label: "抹掉" }, H)?.rule, "power");
	assert.equal(guardComputer("click", { element_token: "e2" }, H, ['[e2] AXButton "取消"\n[e3] AXButton "抹掉"']), null);
});
