# @sigrun/warden

Guardrail extension for [sigrun](https://github.com/sigrun-ai/sigrun):
action classification, holds, and judge-backed confirmations — the
sigrun port of pi-warden's checks, running against pi-warden itself
(`pi-warden` is a runtime dependency).

The warden sits on the `ToolTask` hook (`beforeTool` / `afterTool`) and
decides what happens to every model-issued tool call, by **presence**:

| presence | what a destructive call does |
|---|---|
| **live** (a person is in the conversation) | judged (clear-ask); a vague ask steers the model; an ignored steer — or a judge-free destructive call — seeds a `warden.confirm` interaction and the call waits for the person. Allow runs it; deny refuses it with the reason. |
| **job** (a scheduled job's run) | one-shot grants first (an answered escalation approves one execution); then clearances: a cleared `{job, tool}` runs **only** after the per-target card check passes; everything else blocks and escalates. |
| **internal** (a curator review run) | blocked outright. No escalation. |

`deny` rules block in every presence. `warn` rules never change the
verdict; they log a `warn` record. An unrecognized shell command
(`bash-unknown`) is judged for irreversibility: over the
`thresholds.irreversible` score it is treated as destructive; in a job
it fails closed (block + escalate). A judge failure or a disabled judge
never silently allows: live falls to the interaction hold, jobs block +
escalate, cleared calls block + escalate.

## No decision model

When no decision provider answers (no provider configured, the provider
unreachable, or `judge.enabled: false`):

- **annotations still hold** — MCP tools annotated destructive are
  destructive, annotated read-only / non-destructive are allowed;
- **the bash floor holds** — pi-warden's `isReadOnlyCommand` /
  `matchPatterns` run regardless (raw command, never pre-stripped);
- **user rules hold** — `deny` still blocks, `warn` still logs;
- **live** holds a destructive call on a `warden.confirm` question
  (bash-unknown is allowed offline, pi-warden's own behaviour);
- **jobs** block + escalate, including cleared calls (the card check
  cannot run);
- **nothing autonomous runs unjudged** — the card check, the clear-ask
  judgment, and approval-on-reply all need a judge; without one every
  job presence fails closed.

## What the decision model sees

Everything sent to the decision model is **redacted first** (pi-warden's
`redact`): the tool call's arguments, the request text, the person's
replies, card text, and tool output. The hold log (`holds.jsonl`) stores
the same redacted call JSON.

## Settings

Read from the extension's scoped settings file
(`<configDir>/settings/sigrun-warden.json`), re-read on every tool call. Every
invalid key falls back to its default with one `console.warn` naming the
key (once per key per process).

```jsonc
{
  "judge": { "enabled": true },               // false: no judge calls at all
  "decisionModel": "provider/model",          // optional; default: core's decisions model
  "thresholds": {
    "clearAsk": 0.7,                          // >= this: a clearly-named live call runs
    "card": 0.7,                              // >= this meets AND < escalate for a cleared job call
    "irreversible": 0.9                       // >= this: bash-unknown counts as destructive
  },
  "clearances": [
    { "job": "ext:acme:cleanup", "tools": ["acme-media/torrents_remove"] }
  ],
  "rules": [
    { "match": "command", "pattern": "rm *", "level": "hold" },
    { "match": "tool", "pattern": "acme-media/torrents_*", "level": "deny" },
    { "match": "path", "pattern": "secrets/*", "level": "warn" }
  ],
  "cardModel": "provider/model",              // optional; default: core's utility role
  "steerBudget": 3,                           // steers per run before the warden asks the person itself
  "retentionDays": { "calls": 90, "holds": 365 }
}
```

Rule patterns are anchored `*`-only globs; `*` matches any run within a
segment (`?` and `**` are literal). `command` matches the raw command
string, `tool` the tool name, `path` any string argument.

## Cards

A card is a compact rule digest (≤ 8 KiB) of one skill body, built once
per body hash by `host.models.complete` and stored under the warden's
data root (`cards/<sha256>.json`). Builds are single-flight per hash and
run in the background when a skill body enters a run (a `load_skill`
result, a `read` of a `SKILL.md`, or a `<skill>` block in a prompt). The
per-target card check consults the cards of the skills seen in the run
whose text names the tool — a cleared job call with no governing card
blocks + escalates.

- `/warden cards` — list cards (`skill · hash · builtAt · model`).
- `/warden card <skill>` — the newest card's text.
- `/warden card <skill> --rebuild` — rebuild from the newest copy seen
  in this conversation (newest-first page, so a skill loaded late in a
  long run is found).
- `/warden holds [n]` — the newest `n` hold-log records (default 20),
  newest first: `at · conv <id> · tool · action · outcome`.

## `ask_user_question`

The vague-ask steer names `ask_user_question` unconditionally ("with
ask_user_question if you have it"): a hook cannot see the conversation's
tool list, so the text is the same whether or not the tool is installed.
When it is, an **answered** `ask_user_question` tool result counts as
the person's reply for approval-on-reply — the warden reads the run's
entries and treats the result's text like a user message.

## What the warden is not

Not built (deliberately, this release):

- **runaway detection** — no loop/runaway watchdog;
- **off-task judging** — no "is this call what the user asked" scoring;
- **code review** — nothing judges diff or patch quality;
- **`ask_user_question` itself** — the warden never owns the question
  surface; it only consumes its answered results.

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
