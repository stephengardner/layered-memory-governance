# .claude/hooks

Hook scripts wired into Claude Code via `.claude/settings.json`.

Two kinds of configuration:

- `.claude/settings.json` **IS checked in**. Use it for hooks that encode repo-wide governance rules every contributor should get automatically (e.g., `enforce-lag-ceo-for-gh.mjs`).
- `.claude/settings.local.json` is **per-operator** and gitignored. Use it for hooks that are preference/workflow choices (e.g., the Stop hook below).

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
