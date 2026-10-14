/**
 * shell 词法：把命令行拆成片段，再把片段切成 token（命令名 / 参数 / 重定向目标）。
 * 尊重单双引号与反斜杠转义；命令替换 $(...) / 反引号 / sh -c 里的命令会递归拆出来。
 * heredoc 正文按语义处理：引号分隔符是字面数据；未引号分隔符里的 $(...) 会执行；喂给 shell 的正文是脚本。
 * 纯函数、无 Node 依赖，供 hard-guard 做「命令位置」判断，避免把纯文本参数当成命令。
 */

export type Tok = { value: string; kind: "word" | "redirect" | "heredoc" };

export const CMD_WRAPPERS = /^(sudo|doas|command|nohup|time|env|nice|ionice|stdbuf|exec|builtin|then|do|else|elif|if|while|until)$/i;
const SHELL_CMDS = /^(bash|sh|zsh|dash|ksh|ash|mksh|posh|fish)(\.exe)?$/i;

/** 跳过双引号字符串，返回结束引号的下标（没有则到末尾） */
export function skipDoubleQuoted(s: string, start: number): number {
	let i = start + 1;
	while (i < s.length) {
		const ch = s[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === '"') return i;
		i++;
	}
	return s.length;
}

/** 读一段 $( ... )（s[open] === "$"），返回里面的命令和右括号之后的位置 */
export function readCommandSub(s: string, open: number): [string, number] {
	let depth = 1;
	let i = open + 2;
	while (i < s.length) {
		const ch = s[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === "'") {
			const e = s.indexOf("'", i + 1);
			i = e === -1 ? s.length : e + 1;
			continue;
		}
		if (ch === '"') {
			i = skipDoubleQuoted(s, i) + 1;
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return [s.slice(open + 2, i), i + 1];
		}
		i++;
	}
	return [s.slice(open + 2), s.length];
}

/** 读一段反引号命令替换，返回里面的命令和结束反引号之后的位置 */
export function readBacktick(s: string, start: number): [string, number] {
	let i = start + 1;
	while (i < s.length) {
		const ch = s[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === "`") return [s.slice(start + 1, i), i + 1];
		i++;
	}
	return [s.slice(start + 1), s.length];
}

/** 只提取命令替换（$(...) / 反引号）里的命令，不把普通文本当命令 */
export function extractSubs(s: string, out: string[]): void {
	let i = 0;
	while (i < s.length) {
		const ch = s[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === "$" && s[i + 1] === "(") {
			const [inner, next] = readCommandSub(s, i);
			splitSegments(inner, out);
			i = next;
			continue;
		}
		if (ch === "`") {
			const [inner, next] = readBacktick(s, i);
			splitSegments(inner, out);
			i = next;
			continue;
		}
		i++;
	}
}

/** 把一个片段切成 token：引号里的 > | ; & 只是普通字符，重定向目标单独成 token */
export function parseSegment(seg: string): Tok[] {
	const toks: Tok[] = [];
	let cur = "";
	let has = false;
	const flush = () => {
		if (has) toks.push({ value: cur, kind: "word" });
		cur = "";
		has = false;
	};
	let i = 0;
	while (i < seg.length) {
		const ch = seg[i];
		if (ch === "\\") {
			// 只把空白 / 引号 / 反斜杠当作 shell 转义；其余（如 Windows 路径 C:\Windows）保留反斜杠
			const nxt = seg[i + 1];
			if (nxt !== undefined) cur += /[\s"'`\\]/.test(nxt) ? nxt : ch + nxt;
			has = true;
			i += 2;
			continue;
		}
		if (ch === "'") {
			const e = seg.indexOf("'", i + 1);
			const end = e === -1 ? seg.length : e;
			cur += seg.slice(i + 1, end);
			has = true;
			i = end + 1;
			continue;
		}
		if (ch === '"') {
			const stop = skipDoubleQuoted(seg, i);
			cur += seg.slice(i + 1, stop);
			has = true;
			i = stop + 1;
			continue;
		}
		if (/\s/.test(ch)) {
			flush();
			i++;
			continue;
		}
		if (ch === ">" || ch === "<") {
			// fd 前缀（2>、1>>）不算词
			if (/^\d+$/.test(cur)) {
				cur = "";
				has = false;
			} else flush();
			let j = i + 1;
			let op = ch;
			if (seg[j] === ch) {
				op += ch;
				j++;
			}
			if (op === "<<" && seg[j] === "<") {
				op = "<<<";
				j++;
			}
			if (ch === ">" && seg[j] === "&") {
				// 复制文件描述符（>&2、2>&1）：没有文件目标
				j++;
				while (j < seg.length && /[0-9-]/.test(seg[j])) j++;
				i = j;
				continue;
			}
			while (j < seg.length && /\s/.test(seg[j])) j++;
			let t = "";
			while (j < seg.length && !/\s/.test(seg[j])) {
				const c2 = seg[j];
				if (c2 === "\\") {
					const nxt = seg[j + 1];
					if (nxt !== undefined) t += /[\s"'`\\]/.test(nxt) ? nxt : c2 + nxt;
					j += 2;
					continue;
				}
				if (c2 === "'") {
					const e = seg.indexOf("'", j + 1);
					const end = e === -1 ? seg.length : e;
					t += seg.slice(j + 1, end);
					j = end + 1;
					continue;
				}
				if (c2 === '"') {
					const stop = skipDoubleQuoted(seg, j);
					t += seg.slice(j + 1, stop);
					j = stop + 1;
					continue;
				}
				t += c2;
				j++;
			}
			if (op === "<<" || op === "<<-" || op === "<<<") toks.push({ value: t, kind: "heredoc" });
			else if (op === ">" || op === ">>") toks.push({ value: t, kind: "redirect" });
			else toks.push({ value: t, kind: "word" }); // 输入重定向 < 不是写入目标
			i = j;
			continue;
		}
		cur += ch;
		has = true;
		i++;
	}
	flush();
	return toks;
}

/** 片段里的词（去引号 / 转义后的值） */
export const wordsOf = (seg: string): string[] =>
	parseSegment(seg)
		.filter((t) => t.kind === "word")
		.map((t) => t.value);

/** 找到真正执行命令的词下标：跳过 sudo/env 等前缀、选项和 VAR=值 赋值 */
export function commandIndex(words: string[]): number {
	for (let i = 0; i < words.length; i++) {
		const w = words[i].replace(/^[({!]+/, "");
		if (!w) continue;
		if (CMD_WRAPPERS.test(w)) continue;
		if (/^(-u|--user|-g|--group)$/.test(w)) {
			i++;
			continue;
		}
		if (w.startsWith("-")) continue;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue;
		return i;
	}
	return -1;
}

export const baseName = (w: string) => (w.split(/[\\/]/).pop() ?? w).toLowerCase();
export const isFlag = (t: string) => /^-/.test(t) || /^\/[A-Za-z]$/.test(t);
export const isAbsPath = (t: string) => t.startsWith("/") || /^[A-Za-z]:[\\/]/.test(t);
export const underPath = (base: string, t: string) => {
	if (!base || !t) return false;
	if (t === base) return true;
	const b = base.endsWith("/") || base.endsWith("\\") ? base : `${base}/`;
	return t.startsWith(b) || t.startsWith(`${base}\\`);
};

/** 真正被写入 / 删除的目标路径：重定向目标 + 写入类命令的路径参数（区分 cp 源与目标等方向） */
export function writeTargets(cmd: string, args: string[], rts: string[]): string[] {
	const pos = args.filter((a) => !isFlag(a));
	// 写 /dev/null、/dev/stdout、/dev/stderr 是无副作用的丢弃，不算修改
	const files = rts.filter((t) => t && !/^\/dev\/(null|stdout|stderr)$/.test(t));
	const out: string[] = [];
	if (/^(tee|chmod|chown|truncate|ln|chflags|xattr|icacls|takeown|attrib|set-content|add-content|out-file|new-item)$/i.test(cmd)) out.push(...pos);
	else if (/^(cp|install|ditto|rsync|copy-item)$/i.test(cmd)) {
		if (pos.length) out.push(pos[pos.length - 1]); // 只算目标，源可以是受保护目录
	} else if (/^(mv|move-item|ren|rename)$/i.test(cmd)) out.push(...pos); // 移出 / 移入都算
	else if (/^(rm|rmdir|del|erase|rd|unlink|shred|remove-item)$/i.test(cmd)) out.push(...pos);
	else if (cmd === "sed" && args.some((a) => /^-[a-zA-Z]*i/.test(a)) && pos.length) out.push(pos[pos.length - 1]); // 仅 sed -i 才写
	else if (/^(nano|vi|vim|nvim|emacs|code|micro|pico|joe|subl|notepad|notepad\+\+)$/i.test(cmd) && pos.length) out.push(pos[pos.length - 1]); // 编辑器：只算被编辑的文件
	return [...out, ...files];
}

/** 把一个片段里的命令名和参数取出来（已去引号） */
export function commandOf(seg: string): { cmd: string; args: string[] } {
	const words = wordsOf(seg);
	const i = commandIndex(words);
	return i < 0 ? { cmd: "", args: [] } : { cmd: baseName(words[i]), args: words.slice(i + 1) };
}

/** 取片段里真正执行的命令名（路径取基本名） */
export const firstCommand = (seg: string) => commandOf(seg).cmd;

/** 把一条 shell 命令按 ; && || | 换行 拆成片段（引号里的分隔符不算），并递归拆 sh -c */
export function segments(cmd: string): string[] {
	const out: string[] = [];
	splitSegments(cmd, out);
	for (const seg of [...out]) {
		const m = /^(?:sudo\s+)?(?:[\w./-]*\/)?(?:ba|z|k|da)?sh(?:\.exe)?\s+(?:\S+\s+)*-c\s+([\s\S]+)$/i.exec(seg);
		if (!m) continue;
		const inner = strip(m[1].trim());
		if (inner && inner !== seg) splitSegments(inner, out);
	}
	return out;
}

export function splitSegments(cmd: string, out: string[]): void {
	let cur = "";
	const flush = () => {
		const t = cur.trim();
		if (t) out.push(t);
		cur = "";
	};
	let i = 0;
	while (i < cmd.length) {
		const ch = cmd[i];
		if (ch === "\\" && i + 1 < cmd.length) {
			cur += cmd.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (ch === "'") {
			// 单引号里不做任何替换，原样读到下一个单引号
			const e = cmd.indexOf("'", i + 1);
			const stop = e === -1 ? cmd.length : e + 1;
			cur += cmd.slice(i, stop);
			i = stop;
			continue;
		}
		if (ch === '"') {
			const stop = skipDoubleQuoted(cmd, i);
			extractSubs(cmd.slice(i + 1, stop), out);
			cur += cmd.slice(i, Math.min(stop + 1, cmd.length));
			i = stop + 1;
			continue;
		}
		if (ch === "`") {
			const [inner, next] = readBacktick(cmd, i);
			splitSegments(inner, out);
			cur += cmd.slice(i, next);
			i = next;
			continue;
		}
		if (ch === "$" && cmd[i + 1] === "(") {
			const [inner, next] = readCommandSub(cmd, i);
			splitSegments(inner, out);
			cur += cmd.slice(i, next);
			i = next;
			continue;
		}
		if (ch === "\n" || ch === ";") {
			flush();
			i++;
			continue;
		}
		if (ch === "&" && cmd[i + 1] === "&") {
			flush();
			i += 2;
			continue;
		}
		if (ch === "|") {
			flush();
			i += cmd[i + 1] === "|" ? 2 : 1;
			continue;
		}
		cur += ch;
		i++;
	}
	flush();
}

export const strip = (s: string) => s.replace(/^["']|["']$/g, "");

/** 一行里 << / <<- 的 heredoc 分隔符（跳过引号内的 <<，<<< here-string 不算），并记录分隔符是否带引号 */
function heredocDelims(line: string): { delim: string; stripTabs: boolean; quoted: boolean }[] {
	const out: { delim: string; stripTabs: boolean; quoted: boolean }[] = [];
	let i = 0;
	while (i < line.length) {
		const ch = line[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === "'") {
			const e = line.indexOf("'", i + 1);
			i = e === -1 ? line.length : e + 1;
			continue;
		}
		if (ch === '"') {
			i = skipDoubleQuoted(line, i) + 1;
			continue;
		}
		if (ch === "`") {
			const [, next] = readBacktick(line, i);
			i = next;
			continue;
		}
		if (ch === "$" && line[i + 1] === "(") {
			const [, next] = readCommandSub(line, i);
			i = next;
			continue;
		}
		if (ch === "<" && line[i + 1] === "<") {
			if (line[i + 2] === "<") {
				i += 3;
				continue;
			}
			let j = i + 2;
			let stripTabs = false;
			let quoted = false;
			if (line[j] === "-") {
				stripTabs = true;
				j++;
			}
			while (j < line.length && /\s/.test(line[j])) j++;
			let d = "";
			while (j < line.length && !/[\s;&|<>()]/.test(line[j])) {
				const c2 = line[j];
				if (c2 === "'") {
					quoted = true;
					const e = line.indexOf("'", j + 1);
					d += line.slice(j + 1, e === -1 ? line.length : e);
					j = e === -1 ? line.length : e + 1;
					continue;
				}
				if (c2 === '"') {
					quoted = true;
					const stop = skipDoubleQuoted(line, j);
					d += line.slice(j + 1, stop);
					j = stop + 1;
					continue;
				}
				if (c2 === "\\") {
					quoted = true;
					d += line[j + 1] ?? "";
					j += 2;
					continue;
				}
				d += c2;
				j++;
			}
			if (d) out.push({ delim: d, stripTabs, quoted });
			i = j;
			continue;
		}
		i++;
	}
	return out;
}

/** 该行是否把 stdin（heredoc 正文）喂给 shell 执行：命令位置是 shell，或管道末端是 shell */
function lineFeedsShell(line: string): boolean {
	for (const seg of splitOnPipe(line)) if (SHELL_CMDS.test(firstCommand(seg))) return true;
	return false;
}

/** 只按管道拆（供 heredoc 判定用；引号内的 | 不算） */
function splitOnPipe(line: string): string[] {
	const out: string[] = [];
	let cur = "";
	let i = 0;
	while (i < line.length) {
		const ch = line[i];
		if (ch === "\\") {
			cur += line.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (ch === "'") {
			const e = line.indexOf("'", i + 1);
			const stop = e === -1 ? line.length : e + 1;
			cur += line.slice(i, stop);
			i = stop;
			continue;
		}
		if (ch === '"') {
			const stop = skipDoubleQuoted(line, i);
			cur += line.slice(i, Math.min(stop + 1, line.length));
			i = stop + 1;
			continue;
		}
		if (ch === "|") {
			out.push(cur);
			cur = "";
			i += line[i + 1] === "|" ? 2 : 1;
			continue;
		}
		cur += ch;
		i++;
	}
	out.push(cur);
	return out;
}

/** 未引号 heredoc 正文里会真正执行的命令替换（$(...) / 反引号） */
function subCommands(body: string): string {
	const out: string[] = [];
	extractSubs(body, out);
	return out.join("\n");
}

/**
 * 处理 heredoc 正文：
 * - 引号分隔符（<<'EOF'）是字面数据，丢弃；
 * - 未引号分隔符（<<EOF）正文会做参数/命令替换，保留其中的 $(...) / 反引号；
 * - 正文喂给 shell（bash <<EOF、cat <<EOF | bash）时正文是脚本，原样保留交给片段解析。
 */
export function processHeredocs(cmd: string): string {
	const lines: string[] = [];
	const n = cmd.length;
	let i = 0;
	while (i <= n) {
		const nl = cmd.indexOf("\n", i);
		const end = nl === -1 ? n : nl;
		const line = cmd.slice(i, end);
		const delims = heredocDelims(line);
		lines.push(line);
		i = nl === -1 ? n + 1 : nl + 1;
		if (delims.length) {
			const feedsShell = lineFeedsShell(line);
			for (const d of delims) {
				const body: string[] = [];
				while (i <= n) {
					const e = cmd.indexOf("\n", i);
					const bEnd = e === -1 ? n : e;
					let b = cmd.slice(i, bEnd);
					i = e === -1 ? n + 1 : e + 1;
					if (d.stripTabs) b = b.replace(/^\t+/, "");
					if (b === d.delim || e === -1) break;
					body.push(b);
				}
				const text = body.join("\n");
				if (feedsShell) lines.push(text);
				else if (!d.quoted) lines.push(subCommands(text));
			}
		}
		if (i > n) break;
	}
	return lines.join("\n");
}
