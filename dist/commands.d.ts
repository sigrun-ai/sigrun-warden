import type { ExtensionCommandContribution, SigrunHost } from "@sigrun/sigrun/extension";
import type { WardenSettings } from "./settings-schema.js";
/** What the commands need from the factory's declared settings handle. */
export interface WardenSettingsRead {
    get(): Promise<WardenSettings>;
}
/**
 * Build the warden's slash commands over the host (one per factory). The
 * declared settings read is passed in rather than re-declared: core allows
 * one declaration per extension, and the command reads settings at RUN time
 * (never in the factory body, where the slug is still provisional).
 */
export declare function createWardenCommands(host: SigrunHost, settings: WardenSettingsRead): readonly ExtensionCommandContribution[];
