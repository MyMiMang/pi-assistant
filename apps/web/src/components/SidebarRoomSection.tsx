import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

const STORAGE_KEY = "pia.sidebar.rooms-collapsed";

/** 群聊折叠只影响这个设备的列表展示，不改变正在看的会话。 */
export function SidebarRoomSection({ onCreate, children }: { onCreate: () => void; children: ReactNode }) {
	const id = useId();
	const [collapsed, setCollapsed] = useState(() => {
		try { return localStorage.getItem(STORAGE_KEY) === "1"; } catch { return false; }
	});
	const toggle = () => {
		setCollapsed(!collapsed);
		try { localStorage.setItem(STORAGE_KEY, collapsed ? "0" : "1"); } catch { /* 受限存储仍可临时折叠 */ }
	};
	return (
		<>
			<div className="pa-sec-label flex items-center">
				<button type="button" className="flex min-h-10 flex-1 items-center gap-1 rounded text-left hover:bg-hover" aria-expanded={!collapsed} aria-controls={id} data-testid="sidebar-rooms-toggle" onClick={toggle}>
					{collapsed ? <ChevronRight size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />} 群聊
				</button>
				<button type="button" className="pa-icon-btn ghost !h-9 !w-9" title="新建群聊" aria-label="新建群聊" onClick={onCreate} data-testid="new-room-btn"><Plus size={14} /></button>
			</div>
			<div id={id} hidden={collapsed}>{children}</div>
		</>
	);
}
