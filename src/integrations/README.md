# Integrations

Compose-on seam for external orchestrators that want to govern their own nodes with LAG's substrate primitives (kill-switch, tool policy, auditor, principal attribution) without adopting LAG's reference runtime (runActor, LoopRunner, inbox).

A thin integration wraps a host orchestration primitive (a LangGraph node, a Temporal activity, a Next.js handler, a cron job) with:

- kill-switch check before invocation
- per-principal tool policy evaluation
- auditor emit on start / complete / error
- principal attribution on any atoms the node writes

Each integration lives in a subdirectory with its own `index.ts` and a focused test suite. Consumers import via subpath:

    import { withLagGovernance } from 'layered-autonomous-governance/integrations/langgraph';

Planned integrations: `langgraph/`, `temporal/`, `nextjs/`. The `native` runtime (runActor + LoopRunner) is a peer, not an integration; it lives in `src/runtime/` because it embodies substrate-adjacent design (convergence guards, budget enforcement, inbox-as-atoms) rather than wrapping an external orchestrator.
