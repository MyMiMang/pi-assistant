import type { CustomModel, CustomProviderMeta, FetchedModel } from "./custom-providers.ts";
import { effectiveRelayModel } from "./relay-capabilities.ts";

/** Candidate-only metadata; never persist effectiveCapability or infer it from a model name. */
export function previewRelayAddition(meta: CustomProviderMeta, candidate: CustomModel | FetchedModel) {
	const saved = meta.models.find((m) => m.id === candidate.id);
	const spec = saved ? { ...saved, ...(candidate.listEvidence ? { listEvidence: candidate.listEvidence } : {}) } : candidate;
	return { ...candidate, effectiveCapability: effectiveRelayModel(meta, spec).effectiveCapability };
}
