# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
