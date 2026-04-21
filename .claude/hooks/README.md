# .claude/hooks

Hook scripts wired into Claude Code via `.claude/settings.json`.

Two kinds of configuration:

- `.claude/settings.json` **IS checked in**. Use it for hooks that encode repo-wide governance rules every contributor should get automatically (e.g., `enforce-lag-ceo-for-gh.mjs`).
- `.claude/settings.local.json` is **per-operator** and gitignored. Use it for hooks that are preference/workflow choices (e.g., the Stop hook below).

## seed-canon-on-session.mjs (checked-in, always on)

PreToolUse hook that runs `scripts/bootstrap-all-canon.mjs` once per Claude Code session so the canon store is always caught up to whatever has been merged to main. Guard file lives at `.lag/session-seeds/<session-id>.done`; first tool call per session seeds, subsequent calls short-circuit.

Motivation: session 2026-04-21 surfaced the gap. An atom was edited into a `bootstrap-*-canon.mjs` script, the edit merged to main, but the script was never executed, so when the cto-actor drafted a plan it correctly flagged the cited atom as absent from the store. Source-of-truth (bootstrap scripts) was ahead of the atom store.

Fail-open: a failed bootstrap logs to stderr and allows the tool call; the next session retries. A missing `LAG_OPERATOR_ID` skips seeding with a warning and writes the guard so the warning does not spam every tool call. Wired before the other hooks so seeding races to completion before any gh / pr-state hook would matter.

## enforce-lag-ceo-for-gh.mjs (checked-in, always on)

PreToolUse hook that blocks any raw `gh` CLI call in this repo's Claude Code session and tells the agent to route through `node scripts/gh-as.mjs lag-ceo ...` (or `lag-cto` for decision-bearing ops) instead. This is the third-layer deterministic guarantee described in `docs/bot-identities.md` - in this repo the agent's GitHub attribution is `lag-ceo[bot]` OR the tool call fails loudly; the operator's personal login is never an accidental fallback.

Wired in `.claude/settings.json` so every contributor who opens this repo in Claude Code gets the enforcement automatically.

### Escape hatch

Append `# allow-raw-gh` to a command to explicitly opt out (intended for narrow cases like a test that must run under operator scope).

### Smoke tests

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"gh pr list"}}' | node .claude/hooks/enforce-lag-ceo-for-gh.mjs
# -> stdout: {"decision":"block","reason":"..."} ; exit 0

echo '{"tool_name":"Bash","tool_input":{"command":"node scripts/gh-as.mjs lag-ceo pr list"}}' | node .claude/hooks/enforce-lag-ceo-for-gh.mjs
# -> no output ; exit 0 (allowed)
```

## enforce-pr-status-composite.mjs (checked-in, always on)

PreToolUse hook that blocks ad-hoc PR state reads (`gh pr view`, `gh pr checks`, `gh api .../pulls/<N>`, `gh api .../commits/.../status`, `gh api .../commits/.../check-runs`) and redirects the agent to `node scripts/pr-status.mjs <N>` - the canonical composite read that surfaces every review surface (submitted reviews, line comments, body-nits, check-runs, legacy statuses, mergeStateStatus) in one call.

Belief layer: canon directive `dev-multi-surface-review-observation`. Architectural decision: `arch-pr-state-observation-via-actor-only` (long-term: observation flows through the pr-landing actor; this hook + CLI is the short-term bridge).

Wired in `.claude/settings.json`. Every contributor who opens this repo in Claude Code gets the enforcement automatically.

### Why this exists

Two in-session failures (2026-04-20 and 2026-04-21): the agent polled one surface, missed CodeRabbit review completion on another, and reported stale state. The directive layer was atomized after the first failure and violated again in the same session. Proof that beliefs do not bind agents mechanically; the hook does.

### Escape hatch

Append `# allow-partial-pr-read` to opt out (intended for narrow cases like a test fixture or a single-surface comparison). Default is enforcement.

### Smoke tests

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"gh pr view 52"}}' | node .claude/hooks/enforce-pr-status-composite.mjs
# -> {"decision":"block","reason":"..."}

echo '{"tool_name":"Bash","tool_input":{"command":"node scripts/pr-status.mjs 52"}}' | node .claude/hooks/enforce-pr-status-composite.mjs
# -> no output (allowed)

echo '{"tool_name":"Bash","tool_input":{"command":"gh api repos/o/r/pulls/52/comments"}}' | node .claude/hooks/enforce-pr-status-composite.mjs
# -> no output (allowed; comment READS + posting are not state reads)
```

## stop-continuation-guard.mjs (opt-in per operator)

Stop-event hook that catches premature agent stops (turns where the
last assistant message said "proceeding with X", "starting Y", or
"continuing with Z" but produced zero tool calls).

### To enable

Add to `.claude/settings.local.json` (per-operator decision; not
checked in because some operators prefer not to have their stops
blocked):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node .claude/hooks/stop-continuation-guard.mjs" }
        ]
      }
    ]
  }
}
```

Restart Claude Code after enabling so the hook configuration is
picked up.

### How it works

1. Claude Code fires the Stop hook when a turn is about to end.
2. The hook reads the transcript jsonl, finds the last assistant
   message, and checks:
   - does the text contain a continuation-claim phrase?
   - does the message have zero `tool_use` blocks?
3. If both are true AND `stop_hook_active` is not already true
   (loop guard), the hook emits JSON to stdout:
   `{"decision":"block","reason":"..."}`
   which re-enters the turn with the reason visible.
4. Otherwise it exits 0 silently (allows the stop).

### Fail-open guarantee

Any unexpected input, crash, or parse failure causes the hook to
allow the stop. The hook must never wedge a session.

### Pattern list

Tuned to catch real continuation claims without false positives on
ordinary narrative. See the `CONTINUATION_PATTERNS` array in the
script. Extend the array when new patterns show up in practice.
