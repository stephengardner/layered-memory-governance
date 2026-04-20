# .claude/hooks

Hook scripts wired into Claude Code via `.claude/settings.json`.

## stop-continuation-guard.mjs

Stop-event hook that catches premature agent stops (turns where the
last assistant message said "proceeding with X", "starting Y", or
"continuing with Z" but produced zero tool calls).

### To enable

Add to `.claude/settings.json` (the file is not checked in because
enabling a stop-behavior hook is a per-operator decision):

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
