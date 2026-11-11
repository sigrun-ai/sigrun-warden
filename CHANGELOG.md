# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Judge evaluations now run for the acting user: live calls use the conversation owner and job runs use the job owner, so an unset `decisionModel` follows that user's decision-model default. Core resolves a removed job owner to the primary admin. Both the before-tool and after-tool judges receive the same presence owner.
- `decisionModel` and `cardModel` are model dropdowns in the generated settings form, restricted to decision and chat models respectively. The factory declares the display title `Warden`.
- Requires sigrun 0.15.0 or newer; the `@sigrun/shared` peer range now includes the 0.14 and 0.15 core lines.

## [0.1.8] - 2026-11-10

### Changed

- Declare the warden's settings as JSON Schema through `host.settings.declare`, so its settings page is a generated form (a `Judge` group, the `Thresholds` group, `Clearances` and `Rules` entry lists, a `Retention days` group) and every save is checked against the schema. The hand-written `parseSettings` parser is gone: core applies the same defaults and repairs a malformed stored value to its default — the old per-key fallback, now with a load-time warning instead of a silent `console.warn`. A clearance or rule entry whose required fields are missing or outside their allowed values is dropped, as before; the one difference is that a clearance with a non-string tool now keeps its valid tools instead of being discarded entirely (never more permissive than the file as written — a tool not listed is still not cleared; the old parser voided the whole entry, so a malformed file's job previously held no clearance at all). Requires sigrun 0.13.0 or newer.
- `retentionDays` is a `restart` setting (the hold log prunes once per process); every other key is `live`, re-read on each tool call as before.
- `@sigrun/sigrun` is now a peer dependency (`>=0.13.0`) and `typebox` an exact peer/dev pin (1.3.27), the copies the schema and the declared-settings types come from.

## [0.1.7] - 2026-11-08

- CI: test against the latest released core (core-ref: release). No code change.

## [0.1.6] - 2026-11-08

### Fixed

- Card checks treat an empty array-of-ids argument as one whole-call
  target instead of zero targets, so a cleared destructive call cannot
  pass without being checked. A cleared destructive call that passes
  `ids: []` now escalates instead of silently running, so operators
  whose jobs previously passed vacuously will see new escalations after
  upgrading.
- Core skill preambles whose paths contain spaces are stripped before
  hashing when the preamble ends in `.` followed by a blank line.

## [0.1.5] - 2026-11-07

### Fixed

- An unrecognized shell command in a job escalated unconditionally — the
  irreversibility judgment only ever ran live. Jobs now get the same
  path as live: pi-warden's ask gate passes local commands no answer
  could change, the decision model judges the rest, and only an
  irreversible verdict blocks + escalates. With no decision model a job
  still fails closed (before the gate), and the no-model block reason
  now says so instead of claiming an irreversible verdict.

## [0.1.4] - 2026-11-07

### Fixed

- An MCP tool whose server declares no annotations (or with no
  annotation provider installed) is no longer presumed destructive. It
  classifies as `mcp-unknown` and gets the same irreversibility
  judgment as an unrecognized shell command: below the hold band it
  runs with no question; only an irreversible verdict enters the
  destructive flow (clear ask, steer, hold). Previously every call of an
  unannotated server — e.g. each web search — was held and had to be
  approved one query at a time. In a job, no decision model or a failed
  judgment still fails closed into an escalation; a curator review still
  blocks outright.

### Changed

- `hold` rules now also apply to MCP tools without trustable
  annotations, so an operator can mark an unannotated server dangerous
  (e.g. `{ "match": "tool", "pattern": "acme-media/*", "level": "hold" }`).
- `judgeBashUnknown` is now `judgeUnknown` (the old name stays exported).

## [0.1.3] - 2026-11-07

### Changed

- peer pi-durable/pi-ai/chord ~1.5.0 (requires sigrun 0.11.0).

### Fixed

- afterTool skips results of calls that never ran (pi-durable 1.5.0 hook semantics).

## [0.1.2] - 2026-11-06

### Fixed

- Job grants never worked: `escalation.raise` / `take` / `resolve`
  replies were read straight off core's published-hook envelope
  (`{status: "ok", provider, value}`) instead of its `value`. Every
  raise reported no item (the block text falsely said no escalation
  inbox was installed), every take read as a non-approving grant (an
  approved escalation never released the next run's call), and the
  clearance path (card check) was never reached. The envelope is now
  unwrapped; a rejected/failed take fails closed (block + escalate), a
  failed raise names why, and a failed resolve is logged.

### Changed

- Held-call bodies (job escalations and the live confirm card) show a
  shell command in a `bash` code block with its real line breaks, and
  other arguments as pretty-printed JSON, instead of one long JSON
  line.
- `@sigrun/shared` peer widened to the 0.10 core line.

## [0.1.1] - 2026-11-06

### Fixed

- Annotation mapping read the warden spec's flat `readOnly` /
  `destructive` keys — a shape no provider ever served. The published
  `mcp.tool-annotations` hook (ext-mcp 0.2.3) returns the hints NESTED
  under `annotations`, spelled `readOnlyHint` / `destructiveHint`, so
  every annotated MCP tool — including `readOnlyHint: true` ones —
  classified as destructive (fail-closed, but wrong: read-only calls
  were held/steered). The mapping now reads the nested wire shape
  (nested wins; the flat keys stay accepted defensively). Found live
  during the 2026-11-05 rollout: `transmission_list_torrents` was
  steered on a clear list request.

## [0.1.0] - 2026-11-05

### Added

- `/warden holds [n]` (default 20): the newest hold-log records, newest
  first (`at · conv · tool · action · outcome`), rendered from the log's
  redacted `call` field; a missing log answers "no holds recorded".
- Operator README: the routing matrix, every setting with its default,
  the no-decision-model behaviour, what reaches the decision model
  (all redacted), the cards commands, the `ask_user_question` interplay,
  and the explicit not-built list.

- Extension scaffold: factory declares the `sigrun.warden` extension with
  the `warden.confirm` interaction kind and an empty `ToolTask` hook.
- Settings parsing (`parseSettings`): spec defaults, per-key fallback with
  once-per-key-per-process warnings.
- Classification (`classify`): the §3.1 order — deny rules, core read-only
  names, bash via pi-warden's `isReadOnlyCommand`/`matchPatterns` (raw
  command, never pre-stripped), MCP annotations lookup
  (`mcp.tool-annotations`; absent provider → destructive), hold rules,
  allow. Warn rules surface matched patterns without changing the verdict.
- Hold log (`HoldLog`): JSONL at `paths.state/holds.jsonl` with `append`,
  `recent(n)`, and retention split `prune({calls, holds})`.
- Anchored glob matcher (`globToRegExp`): `*` only, anchored, matching
  within a segment (`?` and `**` are literal).
- Operator guard: bash commands containing `< & | ; \` $(` skip the
  read-only fast path and land bash-unknown — a fail-closed widening.
