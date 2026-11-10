# AGENTS.md — sigrun-warden

Guidance for coding agents working in this repository.

## What this is

`@sigrun/warden`, the sigrun port of pi-warden's guardrails: action
classification, holds, judge-backed confirmations. `pi-warden` is a
runtime dependency; its root export is the source of truth for shell
classification (`matchPatterns`, `isReadOnlyCommand`).

## Layout

- `src/index.ts` — the default-export factory (arity one: host first,
  test deps second) returning the extension + `interactionKinds`.
- `src/settings-schema.ts` — the settings JSON Schema (`host.settings.declare`
  in the factory); core owns the defaults and the malformed-value repair.
  Settings are read per tool call, never in the factory body (its slug is
  the package-derived provisional one, not `sigrun-warden`).
- `src/classify.ts` — the §3.1 classification order; do not reorder.
- `src/log.ts` — JSONL hold log with retention-split prune.
- `src/glob.ts` — anchored `*`-only globs (`*` matches within a segment).

## Conventions

- Never pre-strip a bash command before `matchPatterns` — it handles
  comments and heredocs itself.
- The MCP annotations hook is `mcp.tool-annotations` (hyphen).
- `dist/` is committed (git-source installs load it directly).
- `node_modules/@sigrun/sigrun` and `node_modules/@sigrun/shared` are
  dev symlinks to the core checkout — never commit them.
- Gates: `npm test && npm run typecheck && npm run build` before done.
