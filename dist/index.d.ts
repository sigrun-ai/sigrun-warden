import type { SigrunExtensionResult, SigrunHost } from "@sigrun/sigrun/extension";
/**
 * The warden factory (arity one for the loader; test deps come second).
 * Task 11 wires the ToolTask hook's beforeTool/afterTool for the
 * NO-decision-model path: live conversations hold a call on an
 * interaction question; job runs block + escalate (one-shot grants).
 * The judge (Task 12) and clearances (Task 14) slot in later.
 */
export default function createWarden(host: SigrunHost, deps?: Record<string, never>): SigrunExtensionResult;
export { parseSettings, defaultSettings, resetWarnedKeys } from "./settings.js";
export type { WardenSettings } from "./settings.js";
export { classify, annotationFromHookResult } from "./classify.js";
export type { AnnotationLookup, Classification, ClassifyDeps } from "./classify.js";
export { HoldLog } from "./log.js";
export type { HoldRecord } from "./log.js";
export { globToRegExp, matchGlob } from "./glob.js";
export { presenceOf, runInfo } from "./context.js";
export type { Presence, RunInfo } from "./context.js";
export { grantKey, StateStore } from "./state.js";
export type { ConversationState } from "./state.js";
export { confirmBody, holdForPerson, WARDEN_CONFIRM_KIND } from "./interaction.js";
export { escalationBody, raiseEscalation, resolveGrant, takeGrant, } from "./escalate.js";
export { resetPruneGuardForTests, resolveReservedGrant, routeOffline, startPruneOnce, } from "./route.js";
export type { RouteInput } from "./route.js";
export { Cooldown, decisionsJudge } from "./judge.js";
export { clearAskQuestion } from "./questions.js";
export { evaluateLive, judgeBashUnknown } from "./live.js";
export type { LiveInput, LiveOutcome } from "./live.js";
export { skillTagsInText, skillsInRun } from "./skills.js";
export type { SkillSeen, SkillTag } from "./skills.js";
export { buildCard, CARD_MAX_BYTES, CARD_SYSTEM_PROMPT, CARD_TIMEOUT_MS, CardStore, resetInflightForTests, } from "./cards.js";
export type { Card } from "./cards.js";
export { createWardenCommands } from "./commands.js";
