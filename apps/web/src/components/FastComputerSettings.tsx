/**
 * 快速操作模型设置（按电脑分别设置）。
 *  - `scope="hostpc"` = 用户电脑（设置 › 操作这台电脑）；`scope="computer"` = 助理电脑（设置 › 助理电脑）。
 *  - 默认关闭；开启后主模型仍负责规划、授权与异常判断，快速模型只从程序给出的有限候选里挑一个控件。
 *  - 只从「已配置凭据」的原生 System One（Jev）分类器目录里选；不走 chat 替代，不读全局 Key。
 */
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { Button, Help, Select } from "./ui";

interface FastComputerDto { enabled: boolean; kind: "chat" | "systemone"; provider: string; id: string; baseUrl: string; model: string; threshold: number; timeoutMs: number }
interface ClassifierDto { provider: string; id: string; name: string; api: string; configured: boolean; providerName: string }

export function FastComputerSettingsSection({ scope }: { scope: "hostpc" | "computer" }) {
	const [d, setD] = useState<FastComputerDto | null>(null);
	const [classifiers, setClassifiers] = useState<ClassifierDto[]>([]);
	const [err, setErr] = useState("");
	const [busy, setBusy] = useState(false);
	// 模型目录 / 本地 Laya 注册变化时自动刷新列表：复用既有 store 事件（settings.changed → system、local-laya.changed），
	// 不另建轮询。这样“Laya 稍后启动注册”时已开页面也能出现选项，无需退出重进。
	const layaVersion = useStore((s) => s.localLayaVersion);
	const system = useStore((s) => s.system);
	// 只让最后一次请求落地：旧的迟到响应不覆盖当前数据（保留已加载的选择，不重置）。
	const seq = useRef(0);
	const load = useCallback(() => {
		const my = ++seq.current;
		setErr("");
		return api<{ settings: FastComputerDto; classifierModels?: ClassifierDto[] }>(`/api/fast-computer/settings?scope=${scope}`)
			.then((r) => {
				if (my !== seq.current) return;
				setD(r.settings);
				setClassifiers(r.classifierModels ?? []);
			})
			.catch((e) => {
				if (my !== seq.current) return;
				setErr(e instanceof Error ? e.message : String(e));
			});
	}, [scope]);
	useEffect(() => {
		void load();
		return () => {
			seq.current++;
		};
	}, [load, layaVersion, system]);
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
			const next = await api<FastComputerDto>("/api/fast-computer/settings", { method: "PUT", json: { ...settings, ...patch, scope } });
			seq.current++; // 作废在途的旧读取，避免用旧值覆盖刚保存的选择
			setD(next);
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
				<Help>
					默认关闭。开启只是允许按需使用，不是每步必用，也不保证一定更快。主模型会按任务选择方便、可靠、快捷的方式：已有合适的浏览器或系统接口、目标明确时直接操作；需要从多个候选中选择时才考虑快速模型。拿不准或不可用时由主模型接手，执行后仍核验结果。用户电脑与助理电脑都遵循这条规则，分别设置；尚未单独保存时沿用旧的共用设置。权限与审批规则不变。
					<div className="pt-0.5">
						只列出<b className="text-fg">已配置可用</b>的分类器（如 Jev、已安装并启动的 Laya）。在「模型服务」里配置；本地模型安装进度在「下载与组件」查看。模型分数不代表实际操作成功率。
					</div>
				</Help>
				<button type="button" className="text-xs text-mut hover:text-fg" onClick={() => void load()} data-testid={`fast-refresh-${scope}`}>
					刷新列表
				</button>
			</div>
			<label className="flex items-center gap-2 text-sm">
				<input type="checkbox" aria-label="开启快速操作模型" checked={settings.enabled} disabled={busy} onChange={(e) => void save({ enabled: e.target.checked })} data-testid={`fast-enabled-${scope}`} />
				开启（由主模型按需使用）
			</label>
			{settings.enabled && (
				<div className="space-y-3 border-l border-line pl-3">
					<label className="flex items-center gap-2 text-sm">
						模型
						<Select
							value={value}
							ariaLabel="快速操作模型"
							testId={`fast-classifier-${scope}`}
							placeholder="未选择"
							options={[{ value: "", label: "未选择" }, ...configured.map((m) => ({ value: `${m.provider}/${m.id}`, label: `${m.providerName} · ${m.name}` }))]}
							onChange={setModel}
						/>
					</label>
					{configured.length === 0 ? (
						<p className="text-xs text-mut2" data-testid={`fast-empty-${scope}`}>还没有可用模型，请先在模型服务中添加或安装 Laya。</p>
					) : (
						!value && <p className="flex items-center gap-1 text-xs text-amber-600"><AlertTriangle size={12} /> 还没有选模型，开启也不会生效。</p>
					)}
					{value && !configured.some((m) => `${m.provider}/${m.id}` === value) && (
						<p className="flex items-center gap-1 text-xs text-amber-600"><AlertTriangle size={12} /> 所选模型暂不可用，快速路径会跳过，由主模型继续；可在模型服务中检查或启动。</p>
					)}
					{busy && <p className="flex items-center gap-1 text-xs text-mut"><Loader2 size={12} className="animate-spin" /> 保存中…</p>}
				</div>
			)}
			{err && <p className="text-xs text-red-600">{err}</p>}
		</section>
	);
}
