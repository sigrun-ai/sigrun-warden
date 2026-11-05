# @sigrun/warden

Guardrail extension for [sigrun](https://github.com/sigrun-ai/sigrun):
action classification, holds, and judge-backed confirmations — the
sigrun port of pi-warden's core checks, running against pi-warden
itself (`pi-warden` is a runtime dependency).

**Scaffold state (0.1.0, unreleased).** This package currently ships the
foundation: settings parsing, the §3.1 classification pipeline, and the
JSONL hold log. The `ToolTask` hook is registered but empty — beforeTool
gating, the confirm interaction, and the judge wiring land in follow-up
releases.

## What is here

- `src/settings.ts` — `WardenSettings` + `parseSettings(raw, warn)`.
  Every invalid key falls back to its default with one `console.warn`
  naming the key (once per key per process).
- `src/classify.ts` — `classify(call, deps)` in the spec's exact order:
  deny rule → core read-only names → bash (read-only / `matchPatterns`
  on the **raw** command / bash-unknown) → MCP annotations
  (`server/name` tools; readOnly or `destructive === false` allow,
  everything else destructive, `no-provider` included) → hold rules →
  allow. `warn` rules never change the verdict; matched patterns come
  back in `warns` for the caller to log. The annotations lookup is
  injected; `annotationFromHookResult` maps the
  `mcp.tool-annotations` published-hook result (`absent` → no-provider).
- `src/log.ts` — `HoldLog`: JSONL at `paths.state/holds.jsonl` with
  `append`, `recent(n)`, and `prune({calls, holds})` (hold/block/escalate
  records keep the `holds` window; everything else the `calls` window).
- `src/glob.ts` — anchored `*`-only globs for rule patterns (`*`
  matches any run within a segment; `?` and `**` are literal).

## Settings shape

```jsonc
{
  "judge": { "enabled": true },
  "decisionModel": "provider/model",        // optional
  "thresholds": { "clearAsk": 0.7, "card": 0.7, "irreversible": 0.9 },
  "clearances": [{ "job": "my-job", "tools": ["bash"] }],
  "rules": [
    { "match": "command", "pattern": "rm *", "level": "hold" },
    { "match": "tool", "pattern": "acme-media/torrents_*", "level": "deny" },
    { "match": "path", "pattern": "secrets/*", "level": "warn" }
  ],
  "cardModel": "provider/model",            // optional
  "steerBudget": 3,
  "retentionDays": { "calls": 90, "holds": 365 }
}
```

## Development

```sh
npm install
mkdir -p node_modules/@sigrun
ln -sfn ../sigrun node_modules/@sigrun/sigrun        # or your core checkout
ln -sfn ../sigrun/shared node_modules/@sigrun/shared
npm test          # manifest check + vitest
npm run typecheck
npm run build
```

`dist/` is committed: git-source installs load `dist/index.js` directly.
