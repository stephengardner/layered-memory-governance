# Claude Code Agent Loop Adapter

Production `AgentLoopAdapter` that spawns the Claude Code CLI in agentic-headless mode and streams turn-by-turn output as `agent-turn` atoms. Conforms to the substrate seam at `src/substrate/agent-loop.ts`.

## Usage

```ts
import { ClaudeCodeAgentLoopAdapter } from 'layered-autonomous-governance/examples/agent-loops/claude-code';

const adapter = new ClaudeCodeAgentLoopAdapter({
  // claudePath?: string -- default: 'claude' on PATH
  // killGracePeriodMs?: number -- default: 5000
  // execImpl?: typeof execa -- inject a stub for tests
});

// Pass to AgenticCodeAuthorExecutor (or any consumer of the seam):
const executor = buildAgenticCodeAuthorExecutor({
  agentLoop: adapter,
  workspaceProvider, blobStore, redactor, ghClient, host, principal,
  // ...
});
```

## Capabilities

- `tracks_cost: true` -- reads `cost_usd` from the stream-json `result` envelope.
- `supports_signal: true` -- forwards SIGTERM, then SIGKILL after `killGracePeriodMs`.
- `classify_failure` -- adapter-specific classifier (auth > rate-limit > budget > ENOENT > generic).

## CLI invocation

```
claude -p "<prompt>"
  --output-format stream-json
  --verbose
  --disable-slash-commands
  --mcp-config '{"mcpServers":{}}'
  [--max-budget-usd N]
  [--disallowedTools "Tool1 Tool2 ..."]
```

`--verbose` is REQUIRED for stream-json to emit per-turn lines. The adapter sets `cwd:` via execa's option (the CLI does not accept `--cwd`).

## Authentication

Uses the operator's existing Claude Code OAuth install. No `ANTHROPIC_API_KEY` required.

## Atom emission

Per substrate contract, the adapter writes a placeholder `agent-turn` atom BEFORE each LLM call (on the `system` event for turn 0, on each `user.tool_result` for turn N+1) and `update()`s it as `assistant-text` / `tool_use` / `tool_result` events stream in. A subprocess crash mid-turn leaves a complete audit trail through turn N + a placeholder for the in-flight turn N+1.

Tool-call entries follow the canonical `AgentTurnMeta.tool_calls[]` shape with `tool` / `args` / `result` (each `{inline}|{ref}` discriminated union) / `latency_ms` / `outcome` (`'success' | 'tool-error' | 'policy-refused'`).

## Composition

The adapter is decomposed into 5 unit-testable helpers:

- `stream-json-parser.ts` -- pure NDJSON parser, returns `ReadonlyArray<StreamJsonEvent>` per line (handles multi-block messages).
- `prompt-builder.ts` -- pure prompt assembler from `AgentTask`.
- `classifier.ts` -- adapter-specific failure classifier with explicit precedence.
- `artifacts.ts` -- post-CLI git command runner (commitSha + branch + touched paths).
- `spawn.ts` -- execa wrapper with the canonical argv shape.

Plus the `loop.ts` shell that composes them through the seam.

## Spec

See `docs/superpowers/specs/2026-04-25-real-claude-code-agent-loop-adapter-design.md` for the full design (data flow, error handling, threat model, replay-tier semantics).
