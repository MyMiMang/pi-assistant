/**
 * 快速操作模型设置（按电脑分别设置）。
 *  - `scope="hostpc"` = 用户电脑（设置 › 操作这台电脑）；`scope="computer"` = 助理电脑（设置 › 助理电脑）。
 *  - 默认关闭；开启后主模型仍负责规划、授权与异常判断，快速模型只从程序给出的有限候选里挑一个控件。
 *  - 只从「已配置凭据」的原生 System One（Jev）分类器目录里选；不走 chat 替代，不读全局 Key。
 */
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { Button, Help, Select } from "./ui";

interface FastComputerDto { enabled: boolean; kind: "chat" | "systemone"; provider: string; id: string; baseUrl: string; model: string; threshold: number; timeoutMs: number }
interface ClassifierDto { provider: string; id: string; name: string; api: string; configured: boolean; providerName: string }

export function FastComputerSettingsSection({ scope }: { scope: "hostpc" | "computer" }) {
	const [d, setD] = useState<FastComputerDto | null>(null);
	const [classifiers, setClassifiers] = useState<ClassifierDto[]>([]);
	const [err, setErr] = useState("");
	const [busy, setBusy] = useState(false);
	const load = () => {
		setErr("");
		return api<{ settings: FastComputerDto; classifierModels?: ClassifierDto[] }>(`/api/fast-computer/settings?scope=${scope}`)
			.then((r) => (setD(r.settings), setClassifiers(r.classifierModels ?? [])))
			.catch((e) => setErr(e instanceof Error ? e.message : String(e)));
	};
	useEffect(() => {
		void load();
	}, [scope]);
	if (!d && !err) return <div className="text-xs text-mut" data-testid={`fast-computer-${scope}`}>正在载入快速操作设置…</div>;
	if (!d && err)
		return (
			<div className="space-y-2 text-xs" data-testid={`fast-computer-${scope}`}>
				<div className="text-red-600">快速操作设置载入失败：{err}</div>
				<Button size="sm" variant="outline" onClick={() => void load()} data-testid={`fast-computer-retry-${scope}`}>
					<RefreshCw size={13} /> 重试
				</Button>
			</div>
		);
	const settings = d!;
	const configured = classifiers.filter((m) => m.configured);
	const save = async (patch: Partial<FastComputerDto>) => {
		setBusy(true);
		setErr("");
		try {
			setD(await api<FastComputerDto>("/api/fast-computer/settings", { method: "PUT", json: { ...settings, ...patch, scope } }));
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	const setModel = (v: string) => {
		if (!v) return void save({ provider: "", id: "" });
		const [provider, ...rest] = v.split("/");
		void save({ kind: "systemone", provider, id: rest.join("/") });
	};
	const value = settings.provider && settings.id ? `${settings.provider}/${settings.id}` : "";
	return (
		<section className="space-y-3" data-testid={`fast-computer-${scope}`}>
			<div className="flex items-center gap-2">
				<Help>默认关闭。开启后主模型仍负责规划、授权和异常判断；快速模型只从程序给出的有限候选里挑一个控件，不能自由调工具、不接管会话。选中不等于授权，执行仍走原有权限与审批。每台电脑单独设置。</Help>
				<button type="button" className="text-xs text-mut hover:text-fg" onClick={() => void load()} data-testid={`fast-refresh-${scope}`}>
					刷新列表
				</button>
			</div>
			<label className="flex items-center gap-2 text-sm">
				<input type="checkbox" aria-label="开启快速操作模型" checked={settings.enabled} disabled={busy} onChange={(e) => void save({ enabled: e.target.checked })} data-testid={`fast-enabled-${scope}`} />
				开启（关闭时完全沿用主模型）
			</label>
			{settings.enabled && (
				<div className="space-y-3 border-l border-line pl-3">
					<label className="flex items-center gap-2 text-sm">
						模型
						<Select
							value={value}
							ariaLabel="原生 Jev 分类器模型"
							testId={`fast-classifier-${scope}`}
							placeholder="未选择"
							options={[{ value: "", label: "未选择" }, ...configured.map((m) => ({ value: `${m.provider}/${m.id}`, label: `${m.providerName} · ${m.name}` }))]}
							onChange={setModel}
						/>
					</label>
					<p className="text-xs text-mut2">
						原生 Jev（System One 分类器，有校准概率）。只列出<b className="text-fg">已配置凭据</b>的分类器；鉴权由 Pi 按所选服务解析，不读全局环境变量 Key。
						{configured.length === 0 && " 目前没有已配置的分类器，请先在模型服务里配置 TypeSafe / OpenRouter，或声明 System One 分类器。"}
					</p>
					{settings.enabled && !value && <p className="flex items-center gap-1 text-xs text-amber-600"><AlertTriangle size={12} /> 还没有选模型，开启也不会生效。</p>}
					{busy && <p className="flex items-center gap-1 text-xs text-mut"><Loader2 size={12} className="animate-spin" /> 保存中…</p>}
				</div>
			)}
			{err && <p className="text-xs text-red-600">{err}</p>}
		</section>
	);
}
