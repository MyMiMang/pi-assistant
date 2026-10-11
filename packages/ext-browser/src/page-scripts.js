// 在浏览器页面里执行的脚本（纯 JS，按文本注入，避免被 TS 编译器加入辅助函数）
// 只通过 Playwright 公开的 frame.evaluate 调用。
function pageSnapshot(arg) {
	const { prefix, maxItems } = arg;
	for (const el of Array.from(document.querySelectorAll("[data-pia-ref]"))) el.removeAttribute("data-pia-ref");
	const lines = [];
	let n = 0;
	let truncated = false;
	const clean = (s, max = 80) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
	const visible = (el) => {
		const r = el.getBoundingClientRect?.();
		if (!r || (r.width === 0 && r.height === 0)) return false;
		const st = getComputedStyle(el);
		return st.visibility !== "hidden" && st.display !== "none" && Number(st.opacity) > 0.05;
	};
	const roleOf = (el) => {
		const r = el.getAttribute("role");
		if (r) return r;
		const tag = el.tagName.toLowerCase();
		if (tag === "a" && (el).href) return "link";
		if (tag === "button" || tag === "summary") return "button";
		if (tag === "select") return "combobox";
		if (tag === "textarea") return "textbox";
		if (tag === "input") {
			const t = ((el).type || "text").toLowerCase();
			if (t === "hidden") return null;
			if (["button", "submit", "reset", "image"].includes(t)) return "button";
			if (t === "checkbox") return "checkbox";
			if (t === "radio") return "radio";
			if (t === "file") return "file";
			if (t === "range") return "slider";
			return "textbox";
		}
		if ((el).isContentEditable) return "textbox";
		if (/^h[1-6]$/.test(tag)) return "heading";
		if (tag === "img" && el.getAttribute("alt")) return "img";
		if (tag === "canvas" && (el).width >= 100) return "canvas";
		return null;
	};
	const interactive = new Set(["link", "button", "combobox", "textbox", "checkbox", "radio", "file", "slider", "tab", "menuitem", "option", "switch", "searchbox", "listbox", "menuitemcheckbox", "treeitem"]);
	const nameOf = (el) => {
		const h = el;
		const al = el.getAttribute("aria-label");
		if (al) return clean(al);
		const lb = el.getAttribute("aria-labelledby");
		if (lb) return clean(lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" "));
		if (el.id) {
			const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
			if (l) return clean(l.textContent);
		}
		const pl = el.closest("label");
		if (pl && pl !== el) return clean(pl.textContent);
		const tag = el.tagName.toLowerCase();
		if (tag === "input") {
			const i = el;
			if (["button", "submit", "reset"].includes(i.type)) return clean(i.value || i.type);
			return clean(i.placeholder || i.title || i.name);
		}
		if (tag === "textarea") return clean((el).placeholder || el.getAttribute("title") || el.getAttribute("name"));
		if (tag === "img") return clean(el.getAttribute("alt"));
		return clean(h.innerText || el.textContent || el.getAttribute("title") || "");
	};
	const walk = (root, depth) => {
		for (const el of Array.from(root.children)) {
			if (truncated) return;
			const tag = el.tagName.toLowerCase();
			if (["script", "style", "noscript", "template", "svg", "head"].includes(tag)) continue;
			if (!visible(el) && tag !== "option") {
				// 有些容器自身不可见但子元素可见（如 display:contents）；只跳过明确隐藏的
				const st = getComputedStyle(el);
				if (st.display === "none" || st.visibility === "hidden") continue;
			}
			const role = roleOf(el);
			let d = depth;
			if (role) {
				if (n >= maxItems) {
					truncated = true;
					return;
				}
				const name = nameOf(el);
				let line = `${"  ".repeat(Math.min(depth, 6))}- ${role}${name ? ` "${name}"` : ""}`;
				if (interactive.has(role) || role === "canvas") {
					const ref = `${prefix}e${++n}`;
					el.setAttribute("data-pia-ref", ref);
					line += ` [ref=${ref}]`;
				} else n++;
				if (tag === "input" || tag === "textarea") {
					const i = el;
					if (i.type === "password") line += " (密码)";
					else if (i.type === "checkbox" || i.type === "radio") line += i.checked ? " (已选)" : "";
					else if (i.value) line += ` value="${clean(i.value, 60)}"`;
					if (i.disabled) line += " (不可用)";
				}
				if (tag === "select") {
					const s = el;
					line += ` value="${clean(s.selectedOptions[0]?.textContent, 40)}" options=[${Array.from(s.options).slice(0, 15).map((o) => clean(o.textContent, 20)).join(" | ")}]`;
				}
				if (role === "link") {
					const href = (el).getAttribute("href") ?? "";
					if (href && !href.startsWith("javascript")) line += ` → ${href.slice(0, 80)}`;
				}
				const form = el.closest("form");
				if (form && (role === "button") && ((el).type === "submit" || tag === "input")) line += " (提交表单)";
				lines.push(line);
				d = depth + 1;
				// 链接、按钮内部的文本已经在名字里了
				if (role !== "heading" && role !== "textbox" && tag !== "select") {
					if (["link", "button", "option", "tab", "menuitem"].includes(role)) continue;
				}
				if (role === "heading" || tag === "select" || tag === "textarea") continue;
			} else {
				// 纯文字段落：直接子文本较多时输出一行，帮助理解页面
				const own = Array.from(el.childNodes).filter((c) => c.nodeType === 3).map((c) => c.textContent ?? "").join(" ");
				const t = clean(own, 120);
				if (t.length >= 2 && visible(el)) {
					lines.push(`${"  ".repeat(Math.min(depth, 6))}- text "${t}"`);
				}
			}
			if (tag === "iframe") continue;
			walk(el, d);
		}
	};
	if (document.body) walk(document.body, 0);
	return { lines, count: n, truncated };
}

/** 判断某个元素被点击 / 回车时是否属于“有后果”的操作（提交表单、付款、下单、发送…） */
function elementRisk(el) {
	const clean = (s, max = 80) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
	const h = el;
	const text = clean(h.innerText || (el).value || el.getAttribute("aria-label") || el.getAttribute("title") || "");
	const tag = el.tagName.toLowerCase();
	const type = (el.getAttribute("type") || "").toLowerCase();
	const form = el.closest("form");
	const PAY = /(支付|付款|购买|立即购买|下单|结算|提交订单|确认订单|充值|打赏|转账|pay\b|buy\b|purchase|checkout|place order|subscribe)/i;
	const SEND = /(发送|发布|提交|确认|报名|申请|注册|删除|注销|send\b|post\b|publish|submit|confirm|delete|sign up|register)/i;
	if (PAY.test(text)) return { risky: true, label: "付款 / 下单", text, form: form?.getAttribute("action") ?? undefined };
	const isSubmit = (tag === "button" && (type === "submit" || (!type && !!form))) || (tag === "input" && (type === "submit" || type === "image"));
	if (isSubmit) return { risky: true, label: "提交表单", text, form: form?.getAttribute("action") ?? undefined };
	if (SEND.test(text) && ["button", "a", "input", "div", "span"].includes(tag)) return { risky: true, label: "发送 / 提交", text };
	return { risky: false, label: "", text };
}
