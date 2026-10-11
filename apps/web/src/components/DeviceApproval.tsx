import { Smartphone } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import { Button, Modal } from "./ui";

/** 电脑端确认新设备配对（防止二维码被偷拍后被冒用）。 */
export default function DeviceApproval() {
	const { pendingDevices, set } = useStore();
	const d = pendingDevices[0];
	const close = () => set({ pendingDevices: pendingDevices.slice(1) });
	if (!d) return null;
	return (
		<Modal open onClose={close} title="新设备请求连接">
			<div className="space-y-4 p-5 text-center">
				<Smartphone size={40} className="mx-auto text-accent" />
				<div>
					<div className="font-semibold">{d.name}</div>
					<div className="text-sm text-zinc-500">{d.platform}</div>
				</div>
				<p className="text-sm text-zinc-500">允许后，这台设备可以随时访问你的助理。只批准你自己的设备。</p>
				<div className="flex justify-center gap-2">
					<Button variant="outline" onClick={async () => (await api(`/api/devices/${d.id}/reject`, { method: "POST" }), close())}>
						拒绝
					</Button>
					<Button variant="primary" onClick={async () => (await api(`/api/devices/${d.id}/approve`, { method: "POST" }), close())}>
						允许连接
					</Button>
				</div>
			</div>
		</Modal>
	);
}
