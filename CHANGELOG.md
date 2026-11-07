# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-11-07

## [Unreleased]

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
