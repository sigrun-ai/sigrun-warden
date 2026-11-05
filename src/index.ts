import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import type { SigrunExtensionResult, SigrunHost } from "@sigrun/sigrun/extension";

/**
 * The warden factory (arity one for the loader; test deps come second).
 * Task 10 is the scaffold: the extension declares the `warden.confirm`
 * interaction kind and registers the ToolTask hook whose beforeTool /
 * afterTool wiring Task 11 fills in. Settings parsing, classification,
 * and the hold log live in their own modules.
 */
export default function createWarden(
	host: SigrunHost,
	deps: Record<string, never> = {},
): SigrunExtensionResult {
	void host;
	void deps;
	return {
		extension: defineExtension({
			name: "sigrun.warden",
			tools: [],
			hooks: [
				hook(ToolTask, {}),
			],
		}),
		interactionKinds: ["warden.confirm"],
	};
}

export { parseSettings, defaultSettings, resetWarnedKeys } from "./settings.js";
export type { WardenSettings } from "./settings.js";
export { classify, annotationFromHookResult } from "./classify.js";
export type { AnnotationLookup, Classification, ClassifyDeps } from "./classify.js";
export { HoldLog } from "./log.js";
export type { HoldRecord } from "./log.js";
export { globToRegExp, matchGlob } from "./glob.js";
