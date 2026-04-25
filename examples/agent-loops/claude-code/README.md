# ClaudeCodeAgentLoopSkeleton (substrate-validation skeleton)

This is a SKELETON. It validates the `AgentLoopAdapter` seam shape +
atom emission discipline. **It is not the production agentic Claude
Code path.** That is a separate follow-up adapter that consumes the
same interface.

## What it does

- Emits one `agent-session` atom + one `agent-turn` atom per `run()`.
- Applies the Redactor to LLM input + output before atom write.
- Honors `AbortSignal` early-cancellation.
- Optional `stubResponse` for deterministic tests.

## What it doesn't (yet)

- Spawn the Claude Code CLI subprocess.
- Multi-turn iteration.
- Real tool-call emission.
- Strict-tier canon snapshots.

## Indie path

```ts
import { ClaudeCodeAgentLoopSkeleton } from './agent-loops/claude-code';
const adapter = new ClaudeCodeAgentLoopSkeleton();
```

For local development you can use this skeleton to dogfood the
seam. For production-grade multi-turn agent execution, swap in the
production Claude Code adapter (when it ships) or implement your
own `AgentLoopAdapter` against `src/substrate/agent-loop.ts`.
