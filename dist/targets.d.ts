/**
 * The card-check targets of one call (warden spec §3.2): the elements
 * of the FIRST array-of-scalars argument, as strings — the ids the call
 * acts on. With no array-of-scalars argument, the whole call is ONE
 * target: the canonical JSON of its arguments.
 */
/** One call's card-check targets. */
export declare function targetsOf(args: Record<string, unknown>): readonly string[];
