export function createAgyAccountGate() {
	const processes = new Set<{ idle?: () => boolean; retire?: () => Promise<unknown> }>();
	let switching = false, uncertain = false, revision = 0;
	return {
		start() {
			if (switching || uncertain) return null;
			const lease: { idle?: () => boolean; retire?: () => Promise<unknown> } = {};
			processes.add(lease);
			return Object.assign(() => { processes.delete(lease); }, {
				canRetire(idle: () => boolean, retire: () => Promise<unknown>) { lease.idle = idle; lease.retire = retire; },
			});
		},
		switchAccount() {
			if (processes.size || switching || uncertain) return null;
			switching = true; revision++;
			return () => { switching = false; };
		},
		async manage() {
			if (switching || uncertain || [...processes].some(p => !p.idle?.())) return null;
			switching = true; revision++;
			const release = () => { switching = false; };
			try { await Promise.all([...processes].map(p => p.retire!())); return release; }
			catch (error) { release(); throw error; }
		},
		quarantine() { uncertain = true; },
		readRevision() { return switching || uncertain ? null : revision; },
	};
}

export const agyAccountGate = createAgyAccountGate();
