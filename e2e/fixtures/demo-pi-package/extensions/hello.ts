export default function (pi: { registerTool: (t: unknown) => void }) {
	pi.registerTool({
		name: "demo_hello",
		label: "打招呼",
		description: "演示工具：返回一句问候",
		parameters: { type: "object", properties: { name: { type: "string" } } },
		annotations: { readOnlyHint: true },
		async execute(_id: string, p: { name?: string }) {
			return { content: [{ type: "text", text: `你好，${p.name ?? "朋友"}！（来自 demo-pi-package）` }], details: undefined };
		},
	});
}
