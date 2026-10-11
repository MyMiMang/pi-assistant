import { useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { Provider } from "../types";
import { CustomProviderForm, useCustomProviders } from "./CustomProvider";
import { DefaultModelPicker, ProviderList, ProviderSetup, useProviders } from "./Models";
import { Plus } from "lucide-react";
import { AgentEditor } from "./AgentEditor";
import { Button, cx } from "./ui";
import { BRAND } from "@pi-assistant/shared";

/** 首次运行向导：欢迎 → 选模型服务 → 登录 → 默认模型 → 创建第一个助理。已配置过模型（例如删光了助理）时直接进入最后一步。 */
export default function Onboarding() {
	const hasModel = useStore((s) => !!s.system?.modelSetupDone);
	const [step, setStep] = useState(hasModel ? 4 : 0);
	const [provider, setProvider] = useState<Provider | null>(null);
	const { providers, reload } = useProviders();
	const custom = useCustomProviders();
	const [customMode, setCustomMode] = useState(false);
	const finish = async (agentId: string) => {
		await api("/api/settings", { method: "PUT", json: { onboarded: true } });
		const st = useStore.getState();
		await st.loadAgents();
		await st.selectAgent(agentId);
		await st.loadSystem();
	};
	const current = provider ? (providers.find((p) => p.id === provider.id) ?? provider) : null;
	const steps = ["欢迎", "选择模型服务", "登录", "默认模型", "创建助理"];
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/90 p-0 backdrop-blur sm:p-6 ">
			<div className="flex h-full w-full max-w-2xl flex-col overflow-hidden bg-white shadow-2xl sm:h-auto sm:max-h-[90dvh] sm:rounded-2xl dark:bg-zinc-900">
				<div className="flex gap-1.5 px-6 pt-6">
					{steps.map((s, i) => (
						<div key={s} className={cx("h-1 flex-1 rounded-full", i <= step ? "bg-accent" : "bg-zinc-200 dark:bg-zinc-800")} />
					))}
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto p-6">
					{step === 0 && (
						<div className="space-y-4 py-6 text-center">
							<img src="/icon-512.png" className="mx-auto h-20 w-20 rounded-3xl shadow-lg" alt="" />
							<h1 className="text-2xl font-bold">欢迎使用 {BRAND.name}</h1>
							<p className="mx-auto max-w-md text-sm leading-relaxed text-zinc-500">
								{BRAND.tagline}手机扫码就能随时随地使用。
								<br />
								开始前，需要连接一个 AI 模型服务。你的凭据只加密保存在这台电脑上。
							</p>
						</div>
					)}
					{step === 1 && (
						<div className="space-y-3">
							<h2 className="text-lg font-semibold">选择模型服务</h2>
							<p className="text-sm text-zinc-500">支持 API Key，也支持用已有的订阅账号登录（如 ChatGPT、Claude、GitHub Copilot 等）。</p>
							<Button variant="outline" onClick={() => (setProvider(null), setCustomMode(true), setStep(2))}>
								<Plus size={15} /> 自定义服务（中转站 / 第三方 / 本地模型）
							</Button>
							<ProviderList providers={providers} selected={provider?.id} onPick={(p) => (setProvider(p), setCustomMode(!!p.custom), setStep(2))} />
						</div>
					)}
					{step === 2 && customMode && (
						<div className="space-y-3">
							<h2 className="text-lg font-semibold">{current ? "编辑" : "添加"}自定义模型服务</h2>
							<p className="text-sm text-zinc-500">适用于中转站、第三方模型和本地推理服务：填写接口地址和 Key，模型列表可以自动获取或手动输入。</p>
							<CustomProviderForm
								apis={custom.apis}
								initial={current ? custom.providers.find((m) => m.id === current.id) : undefined}
								onSaved={(m) => (setProvider({ id: m.id, name: m.name } as Provider), void reload(), void custom.reload())}
							/>
						</div>
					)}
					{step === 2 && !customMode && current && (
						<div className="space-y-3">
							<h2 className="text-lg font-semibold">登录 {current.id === "mock" ? "Mock 模型" : current.name}</h2>
							<ProviderSetup provider={current} onConfigured={() => void reload()} />
						</div>
					)}
					{step === 3 && (
						<div className="space-y-3">
							<h2 className="text-lg font-semibold">选择默认模型</h2>
							<p className="text-sm text-zinc-500">之后可以在「设置 → 模型」里随时更换，也可以给每个助理单独指定模型。</p>
							<DefaultModelPicker providerId={current?.id} onSaved={() => void api("/api/settings", { method: "PUT", json: { onboarded: true } }).then(() => setStep(4))} />
						</div>
					)}
					{step === 4 && (
						<div className="space-y-4">
							<div>
								<h2 className="text-lg font-semibold">创建你的第一个助理</h2>
								<p className="text-sm text-zinc-500">给它起个名字、挑个头像。之后可以随时再创建更多助理，每个都有自己的人设、模型、记忆和电脑。</p>
							</div>
							<AgentEditor showModel={false} submitLabel="创建并开始" onDone={(a) => void finish(a.id)} />
						</div>
					)}
				</div>
				<div className={cx("flex items-center justify-between border-t border-zinc-200 px-6 py-4 dark:border-zinc-800", step === 4 && "hidden")}>
					{step > 0 ? (
						<Button variant="ghost" onClick={() => setStep(step - 1)}>
							上一步
						</Button>
					) : (
						<span />
					)}
					{step === 0 && (
						<Button variant="primary" onClick={() => setStep(1)}>
							开始设置
						</Button>
					)}
					{step === 2 && (
						<Button variant="primary" disabled={!current || (!current.configured && current.id !== "mock")} onClick={() => setStep(3)}>
							下一步
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}
