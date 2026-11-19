/**
 * The card-check targets of one call (warden spec §3.2): the elements
 * of the first NON-EMPTY array-of-scalars argument, as strings — the
 * ids the call acts on. Empty arrays are skipped; with no non-empty
 * array-of-scalars argument, the whole call is ONE target: the
 * canonical JSON of its arguments.
 */
/** One call's card-check targets. */
export function targetsOf(args: Record<string, unknown>): readonly string[] {
	const key = targetKeyOf(args);
	if (key !== undefined) return (args[key] as unknown[]).map(String);
	// state.ts's canonicalize is private; grantKey's digest is not the
	// target TEXT, so re-derive the canonical JSON here (keys sorted,
	// matching state.ts's shape).
	return [canonicalize(args)];
}

/** The argument holding the call's target list, or undefined when none does. */
export function targetKeyOf(args: Record<string, unknown>): string | undefined {
	for (const [key, value] of Object.entries(args)) {
		if (
			Array.isArray(value) &&
			value.length > 0 &&
			value.every(
				(item) =>
					typeof item === "string" ||
					typeof item === "number" ||
					typeof item === "boolean",
			)
		) {
			return key;
		}
	}
	return undefined;
}

/** Canonical JSON (object keys sorted). */
export function canonicalize(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	return `{${keys
		.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
		.join(",")}}`;
}
