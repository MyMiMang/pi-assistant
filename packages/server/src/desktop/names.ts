/**
 * 助理电脑的硬性保护：永远只操作我们自己命名的实例 / 容器 / 卷 / 镜像（DESIGN §15.2）。
 * 任何发给容器引擎的命令都先经过 assertOwnTarget：目标名字不符合下面的规则就直接拒绝，
 * 不会误删用户自己的 Docker 容器、WSL 发行版或 Lima 实例。
 */
const ID = "[A-Za-z0-9][A-Za-z0-9_.-]{0,63}";
export const CONTAINER_RE = new RegExp(`^pia-desk-${ID}$`);
export const VOLUME_RE = new RegExp(`^pia-home-${ID}$`);
export const LIMA_INSTANCE = "pia-desktop";
export const WSL_DISTRO_RE = /^PiAssistant-[A-Za-z0-9-]{1,40}$/;
export const LABEL = "pia.agent";

/** agentId → 安全片段（只留字母数字 _ . -）；清洗后为空或超长时拒绝 */
export function safeId(agentId: string) {
	const s = agentId.replace(/[^a-zA-Z0-9_.-]/g, "");
	if (!s || s.length > 64 || !/^[A-Za-z0-9]/.test(s)) throw new Error(`助理 id 不合法：${JSON.stringify(agentId)}`);
	return s;
}
export const containerName = (agentId: string) => `pia-desk-${safeId(agentId)}`;
export const volumeName = (agentId: string) => `pia-home-${safeId(agentId)}`;

export const isOwnContainer = (n: string) => CONTAINER_RE.test(n);
export const isOwnVolume = (n: string) => VOLUME_RE.test(n);
export const isOwnLimaInstance = (n: string) => n === LIMA_INSTANCE;
export const isOwnWslDistro = (n: string) => WSL_DISTRO_RE.test(n);
/** 我们自己的镜像：固定仓库（含国内加速地址改写后的同名仓库）或开发用的本地镜像 */
export function isOwnImage(ref: string, repos: string[]) {
	const repo = ref.replace(/@sha256:[a-f0-9]{64}$/, "").replace(/:[A-Za-z0-9_.-]+$/, "");
	return repos.includes(repo);
}

/**
 * 会修改/删除东西的引擎子命令必须带上目标名，并且目标都是我们自己的。
 * 读类命令（version/info/ps/inspect/logs/images/pull 等）不改动用户的东西，照常放行；ps/images 需带我们的过滤条件由调用方保证。
 */
const MUTATING: Record<string, "container" | "volume" | "image"> = {
	start: "container", stop: "container", restart: "container", kill: "container", rm: "container", exec: "container", pause: "container", unpause: "container", rename: "container", update: "container",
};
export function assertOwnTarget(args: string[], repos: string[]) {
	const [cmd, sub] = args;
	const targets = (from: number) => args.slice(from).filter((a, i, all) => !a.startsWith("-") && !FLAG_WITH_VALUE.has(all[i - 1] ?? ""));
	const bad = (what: string, n: string) => {
		throw new Error(`拒绝操作不属于 Pi Assistant 的${what}：${n}`);
	};
	if (cmd === "volume" && (sub === "rm" || sub === "remove")) for (const n of targets(2)) isOwnVolume(n) || bad("卷", n);
	else if (cmd === "volume" && sub === "prune") bad("卷", "(prune)");
	else if ((cmd === "image" && (sub === "rm" || sub === "remove")) || cmd === "rmi") for (const n of targets(cmd === "rmi" ? 1 : 2)) isOwnImage(n, repos) || bad("镜像", n);
	else if (cmd === "tag") isOwnImage(args.filter((a) => !a.startsWith("-"))[2] ?? "", repos) || bad("镜像", args[2] ?? "");
	else if (["system", "container", "image", "network", "builder"].includes(cmd) && sub === "prune") bad("资源", `${cmd} prune`);
	else if (cmd === "run") {
		const i = args.indexOf("--name");
		if (i < 0 || !isOwnContainer(args[i + 1] ?? "")) bad("容器", args[i + 1] ?? "(未命名)");
		const lab = args.findIndex((a, j) => a === "--label" && args[j + 1]?.startsWith(`${LABEL}=`));
		if (lab < 0) bad("容器", `${args[i + 1]}（缺少 ${LABEL} 标签）`);
	} else if (cmd === "cp") {
		// docker cp 本机路径 容器:路径（或反过来）：带冒号的那一端必须是我们自己的容器
		const ends = args.slice(1).filter((a) => !a.startsWith("-"));
		const ct = ends.filter((a) => /^[^/\\]+:/.test(a) && !/^[A-Za-z]:[\\/]/.test(a)).map((a) => a.slice(0, a.indexOf(":")));
		if (ct.length !== 1) bad("容器", ends.join(" "));
		isOwnContainer(ct[0]) || bad("容器", ct[0]);
	} else if (MUTATING[cmd]) {
		// exec 的第一个非选项参数是容器名，后面是容器里要执行的命令
		const t = cmd === "exec" ? targets(1).slice(0, 1) : targets(1);
		if (!t.length) bad("容器", "(未指定)");
		for (const n of t) isOwnContainer(n) || bad("容器", n);
	} else if (!READ_ONLY.has(cmd) && !(cmd === "volume" && (sub === "inspect" || sub === "ls" || sub === "create"))) bad("命令", cmd);
	if (cmd === "volume" && sub === "create") for (const n of targets(2)) isOwnVolume(n) || bad("卷", n);
}
const READ_ONLY = new Set(["version", "info", "ps", "inspect", "logs", "images", "pull", "image", "volume"]);
const FLAG_WITH_VALUE = new Set(["-t", "--time", "-e", "--env", "-u", "--user", "-w", "--workdir", "--signal", "-s"]);

/** 解析 `ps --format {{.Labels}}` 的输出（每行 k=v,k2=v2；docker 也可能输出 map[k:v]），取出某个标签的值 */
export function labelValues(stdout: string, key: string): string[] {
	const out: string[] = [];
	for (const line of stdout.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		const m = t.startsWith("map[") ? new RegExp(`(?:^map\\[|\\s)${key.replace(/\./g, "\\.")}:([^\\s\\]]+)`).exec(t) : new RegExp(`(?:^|,)${key.replace(/\./g, "\\.")}=([^,]*)`).exec(t);
		if (m?.[1]) out.push(m[1]);
	}
	return out;
}
