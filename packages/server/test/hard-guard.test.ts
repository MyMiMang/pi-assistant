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

test("shell：引号 / 转义里的 | ; 等不算分隔符（beta16 误报回归）", () => {
	// 用户截图里的真实命令：grep 参数里的 \|logout 曾被拆成独立 logout 而误报关机
	const screenshot = `cd "/data/pia/pi-assistant" && sed -n '180,230p' packages/server/src/http.ts && echo "=== UI delete ===" && grep -n "delete\\|删除\\|remove\\|logout" apps/web/src/components/CustomProvider.tsx`;
	assert.equal(hit(screenshot), null, screenshot);
	for (const c of [
		'grep -n "delete\\|remove\\|logout" f.ts',
		'grep -rn "shutdown" src/',
		'grep -rn "mkfs\\.ext4" docs/',
		'grep -n "kill -9 1" f.ts',
		'grep -rn "pi-assistant" docs/',
		'echo "shutdown"',
		'echo "please reboot the machine"',
		'echo "fdisk -l"',
		"echo 'rm -rf /'",
		'printf "%s" "mkfs.ext4"',
	]) assert.equal(hit(c), null, c);
	// 真命令（分隔符在引号外）仍然命中
	assert.equal(hit("cat x | shutdown -h now"), "power");
	assert.equal(hit("cat x | mkfs.ext4 /dev/sdb1"), "disk");
	assert.equal(hit("echo a; fdisk -l"), "disk");
	assert.equal(hit("echo a && killall Finder"), "system-proc");
});

test("shell：beta16 真实审批误报记录（只读/文本/方向，全部为 null）", () => {
	// 主会话只读 data.db recent15 里被误报的真实命令
	const real = [
		// 1 gh run view：--repo 参数里的仓库名 + 输出到工作目录文件，不是改自身
		`gh run view --repo MyMiMang/pi-assistant 12345678 --log > beta16-run.json`,
		`gh run view --repo MyMiMang/pi-assistant --log > beta16-run.json 2>&1`,
		// 2 git log：--format 引号里的 > 和 | 是格式串，不是重定向/管道
		`git log --format='%h %an <%ae> | %cn <%ce>' -5`,
		`git log --format="%h %an <%ae> | %cn <%ce>" -5`,
		`git log --pretty=format:'%h %s' --grep=logout`,
		// 3 sed 只读源码、重定向到工作区里带产品名的相对路径
		`sed -n '1,50p' packages/server/src/http.ts > pi-assistant/.tmp-verify-ui.mjs`,
		`sed -n '1,50p' packages/server/src/http.ts > "/data/pia/workspace/a1/pi-assistant/.tmp-verify-ui.mjs"`,
		// 4 export PATH 里带产品名 + typecheck，不是改自身
		`export PATH="/opt/homebrew/bin:/Applications/Pi Assistant.app/Contents/MacOS:$PATH" && npm run typecheck`,
		`export PATH='/opt/homebrew/bin:/Applications/Pi Assistant.app/Contents/MacOS':$PATH; npm run typecheck`,
		// 5 heredoc 正文里的危险词是文本，不是要执行的命令
		`cat > /tmp/probe.ts <<'EOF'\nconst x = "logout";\nshutdown -h now\nrm -rf /\nEOF\nnode /tmp/probe.ts`,
		`cat > /tmp/x.sh <<EOF\nreboot\nmkfs.ext4 /dev/sdb1\nEOF`,
		// 6 cp 方向：从受保护目录读到 /tmp，不是写数据目录
		`cp "/data/pia/models.json" /tmp/isolated/`,
		`cp -v /data/pia/pia.db /tmp/backup/`,
		`cp /data/pia/workspace/models.json /tmp/isolated/`,
	];
	for (const c of real) assert.equal(hit(c), null, c);
});

test("shell：日常检索/文本里的危险词不误报，真正复合执行仍命中", () => {
	// 危险词只是 grep/rg/echo/print 的参数或输出文本
	const benign = [
		`grep -rn "shutdown" src/`,
		`grep -rn "mkfs.ext4" docs/`,
		`grep -rn "rm -rf /" docs/`,
		`grep -rn "password" packages/`,
		`grep -rn "kill -9" src/`,
		`rg -n "shutdown|reboot|halt" packages/`,
		`rg --files-with-matches "password" .`,
		`echo "shutdown -h now"`,
		`echo "mkfs.ext4 /dev/sdb1"`,
		`echo "rm -rf /"`,
		`echo "killall Finder"`,
		`echo "password: hunter2"`,
		`node -e "console.log('shutdown')"`,
		`python3 -c "print('mkfs')"`,
		`git commit -m "fix logout button"`,
		`cat README.md | grep shutdown`,
		`cat /etc/passwd`,
		`sed -n '1,10p' /data/pia/pia.db > /tmp/out.txt`,
		`rm -rf pi-assistant/node_modules`,
		`echo x > /data/pia/workspace/a1/out.txt`,
	];
	for (const c of benign) assert.equal(hit(c), null, c);
	// 真正的复合危险执行仍然命中（分隔符在引号外 / 命令位置）
	assert.equal(hit("grep x f.ts && shutdown -h now"), "power");
	assert.equal(hit("cat > /tmp/x.sh <<'EOF'\nhello\nEOF\nshutdown -h now"), "power", "heredoc 之后的真命令仍命中");
	assert.equal(hit("echo x > /data/pia/pia.db"), "self-data");
	assert.equal(hit("cat > /data/pia/pia.db <<'EOF'\nhi\nEOF"), "self-data");
	assert.equal(hit("cp /tmp/x /data/pia/pia.db"), "self-data");
	assert.equal(hit("mv /data/pia/pia.db /tmp/"), "self-data");
	assert.equal(hit('echo x > "/Applications/Pi Assistant.app/f"'), "self");
	assert.equal(hit('chmod 777 "/Applications/Pi Assistant.app"'), "self");
	assert.equal(hit("docker rm -f pia-desk-abc"), "self");
	assert.equal(hit("brew uninstall pi-assistant"), "self");
});

test("shell：命令位置判断（参数/引号里的危险词不算，不靠 .test(s) 扫描）", () => {
	for (const c of [
		`echo 'systemctl poweroff'`,
		`echo "systemctl reboot"`,
		`grep 'diskutil eraseDisk' f.txt`,
		`echo '.zshrc >'`,
		`echo '/usr/bin >'`,
		`echo 'crontab -r'`,
		`echo 'dscl . -create /Users/x'`,
		`echo 'useradd hacker'`,
		`export PATH='/Applications/Pi Assistant.app/Contents/MacOS:$PATH'`,
		`grep -n 'net user admin /add' docs/`,
		`grep 'uninstall pi-assistant' docs/`,
		`echo 'stress-ng'`,
		`cp '/Applications/Pi Assistant.app/config' /tmp/config`,
		`cp /usr/bin/ls /tmp/ls`,
		`cp ~/.zshrc /tmp/zshrc`,
		`sed -n '/shutdown/p' /etc/hosts > /data/pia/workspace/out`,
	])
		assert.equal(hit(c), null, c);
	assert.equal(hit("echo a; fdisk -l"), "disk");
	assert.equal(hit("systemctl poweroff"), "power");
	assert.equal(hit("diskutil eraseDisk APFS X disk2"), "disk");
	assert.equal(hit("del C:\\Windows\\System32\\x.dll"), "system-dir");
	assert.equal(hit("stress-ng --cpu 8"), "fork-bomb");
	assert.equal(hit("nano ~/.zshrc"), "rc");
	assert.equal(hit("cp /tmp/config '/Applications/Pi Assistant.app/config'"), "self");
});

test("shell：heredoc 正文按语义处理（字面数据 / 未引号 $(...) 会执行 / 喂给 shell 是脚本）", () => {
	// 引号分隔符 = 字面数据
	assert.equal(hit(`cat <<'EOF'\nshutdown -h now\nrm -rf /\nEOF`), null);
	assert.equal(hit(`cat > /tmp/x.sh <<'EOF'\nlogout\nmkfs.ext4 /dev/sdb1\nEOF`), null);
	assert.equal(hit(`cat <<"EOF"\nreboot\nEOF`), null);
	// 未引号分隔符：正文里的 $(...) 会真正执行
	assert.equal(hit(`cat <<EOF\n$(shutdown -h now)\nEOF`), "power");
	assert.equal(hit('cat <<EOF\n`shutdown -h now`\nEOF'), "power");
	assert.equal(hit(`cat <<'EOF'\n$(shutdown -h now)\nEOF`), null);
	assert.equal(hit(`cat <<EOF\nprefix $(rm -rf /) suffix\nEOF`), "mass-delete");
	// 正文喂给 shell：就是脚本，照样拦
	assert.equal(hit(`bash <<'EOF'\nshutdown -h now\nEOF`), "power");
	assert.equal(hit(`bash <<EOF\nmkfs.ext4 /dev/sdb1\nEOF`), "disk");
	assert.equal(hit(`cat <<'EOF' | bash\nrm -rf /\nEOF`), "mass-delete");
	assert.equal(hit(`sh -s <<'EOF'\nreboot\nEOF`), "power");
	// heredoc 之后的真命令仍命中
	assert.equal(hit(`cat > /tmp/x.sh <<'EOF'\nhello\nEOF\nshutdown -h now`), "power");
});

test("shell：嵌套执行（命令替换 / 反引号 / sh -c）仍然命中", () => {
	assert.equal(hit("echo $(shutdown -h now)"), "power");
	assert.equal(hit("echo `reboot`"), "power");
	assert.equal(hit('echo "$(mkfs.ext4 /dev/sdb1)"'), "disk");
	assert.equal(hit("bash -c 'shutdown -h now'"), "power");
	assert.equal(hit('sudo sh -c "mkfs.ext4 /dev/sdb1"'), "disk");
	assert.equal(hit("echo $(rm -rf /)"), "mass-delete");
	assert.equal(hit("echo `killall Finder`"), "system-proc");
	assert.equal(hit("echo $(echo hello)"), null);
});

test("shell：只读命令（带无副作用重定向）不算写删系统目录", () => {
	for (const c of ["ls /usr/local/bin/node 2>/dev/null", "ls -la /usr/local/bin/node 2>&1", "which node; ls /usr/local/bin/node", 'ls "/Applications/Pi Assistant.app" 2>/dev/null', "ls /usr/local/bin > /tmp/out.txt", "ls /usr/bin/git 2>/dev/null | head", "cat /usr/local/bin/node | head", "stat /usr/local/bin/node 2>/dev/null"])
		assert.equal(hit(c), null, c);
	// 真写入仍然命中
	assert.equal(hit("ls /usr/local/bin/node > /usr/local/bin/out"), "system-dir");
	assert.equal(hit("echo x > /etc/hosts"), "system-dir");
	assert.equal(hit('echo x > "/Applications/Pi Assistant.app/f"'), "self");
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
