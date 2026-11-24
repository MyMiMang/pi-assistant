// Triplet plus an optional decimal build ID; no prefix or lexicographic comparison.
function parts(version: unknown): bigint[] | undefined {
	if (typeof version !== "string" || version.length > 128) return;
	const m = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(0|[1-9][0-9]*))?$/.exec(version);
	if (m?.[0] === version) return [BigInt(m[1]), BigInt(m[2]), BigInt(m[3]), m[4] === undefined ? -1n : BigInt(m[4])];
}

export function agyManifestVersion(pathVersion: string, declared: unknown): boolean {
	if (!parts(pathVersion)) return false;
	if (declared === undefined || declared === pathVersion) return true;
	const dash = pathVersion.indexOf("-");
	return dash !== -1 && declared === pathVersion.slice(0, dash);
}

export function compareAgyVersions(a: string, b: string): number | undefined {
	const lhs = parts(a), rhs = parts(b);
	if (!lhs || !rhs) return;
	for (let i = 0; i < lhs.length; i++) if (lhs[i] !== rhs[i]) return lhs[i] > rhs[i] ? 1 : -1;
	return 0;
}
