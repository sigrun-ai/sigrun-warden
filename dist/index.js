import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
/**
 * The warden factory (arity one for the loader; test deps come second).
 * Task 10 is the scaffold: the extension declares the `warden.confirm`
 * interaction kind and registers the ToolTask hook whose beforeTool /
 * afterTool wiring Task 11 fills in. Settings parsing, classification,
 * and the hold log live in their own modules.
 */
export default function createWarden(host, deps = {}) {
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
export { classify, annotationFromHookResult } from "./classify.js";
export { HoldLog } from "./log.js";
export { globToRegExp, matchGlob } from "./glob.js";
