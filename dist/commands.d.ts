import type { ExtensionCommandContribution, SigrunHost } from "@sigrun/sigrun/extension";
/** Build the warden's slash commands over the host (one per factory). */
export declare function createWardenCommands(host: SigrunHost): readonly ExtensionCommandContribution[];
