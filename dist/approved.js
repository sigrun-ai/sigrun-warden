import { canonicalize, targetKeyOf } from "./targets.js";
/** The approved call that authorizes `call`, or undefined. */
export function approvalFor(call, approved) {
    return approved.find((entry) => entry.tool === call.name && matches(call.arguments, entry.arguments));
}
function matches(args, approved) {
    const key = targetKeyOf(args);
    if (key === undefined || key !== targetKeyOf(approved)) {
        return canonicalize(args) === canonicalize(approved);
    }
    const { [key]: targets, ...rest } = args;
    const { [key]: approvedTargets, ...approvedRest } = approved;
    if (canonicalize(rest) !== canonicalize(approvedRest))
        return false;
    const allowed = new Set(approvedTargets.map(String));
    return targets.every((target) => allowed.has(String(target)));
}
