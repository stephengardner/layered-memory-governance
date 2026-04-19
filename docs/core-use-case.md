# Core Use Case

The narrow single-user-across-weeks scenario. This is V0's target. Everything in `framework.md` exists to serve THIS case first. Multi-agent, autonomous org, and related ambitions are out of scope for V0.

## User story

A developer works across two long-running codebases for weeks. Each Claude Code (or similar agent) session in one of those workspaces:

1. Starts with relevant memory from prior sessions surfaced automatically.
2. Observes decisions, preferences, gotchas as they happen.
3. Ends with memories persisted, scoped to the correct project.

Over weeks, memory accumulates. Decisions reverse. Stale facts fade. New facts supersede old. The system remains coherent without the user re-explaining previously-settled things.

## V0 acceptance criteria (closes Q19)

The system is considered "V0-done" when all of the following hold under the simulation harness AND in real usage over at least 30 days:

1. **Session-start relevance**: retrieval at session start returns the top 20 memories most relevant to the current working directory and recent commit context, not a random sample. Verified by human review of at least 10 sampled sessions.

2. **Decision persistence**: the user makes a decision mid-session. A new session at least 7 days later surfaces the decision when asked a related question, without prompting.

3. **Reversal supersession**: the user reverses a prior decision. The old atom is marked `superseded_by` the new atom. Default retrieval returns only the new atom. Explicit history query returns both with ordering.

4. **Calibration**: auto-merge reversal rate under 10% over a rolling 30-day window. Canon-drift-from-oracle (simulation metric) under 15%.

5. **No contradictions at retrieval**: a given query never returns two atoms with conflicting high-confidence claims. Conflicts detected at write time, arbitrated before the conflicting atom is stored at its target layer.

6. **Coherent summarization**: the user asks "what do you remember about X". The system produces a coherent synthesized answer, not a grab-bag list. Grounded in retrieved atoms (grounding rate > 80%).

7. **Scope isolation**: one project's memories do not surface in another project's sessions by default. Explicit cross-scope query allowed but opt-in.

8. **Stale fade**: atoms older than their type's half-life without reinforcement do not appear in default retrieval. Search with `include_stale=true` still finds them.

## What V0 does NOT have to solve

- Multi-agent coordination beyond a single user running two concurrent Claude Code sessions in the same workspace. Full multi-agent orchestration is V1.
- Autonomous canon promotion. V0 auto-merge is conservative; most promotions telegraph for review.
- External notification channels (Telegram, SMS). File-queue + session-inject is sufficient for V0.
- Self-loop autonomous agents that write without the author-initiated sessions. V1.
- Cross-machine sync. V0 is single-machine.
- Other users / teams. V0 is single-user.

## Mapping acceptance criteria to simulation scenarios

| Criterion | Exercised by | Status |
|---|---|---|
| 1 session-start relevance | Q-ε retrieval benchmark (`test/bench/retrieval-scale.test.ts`), 10K atoms x 20 clusters, trigram + onnx; see `design/phase-15-findings.md` + `design/phase-17-findings.md` | implemented |
| 2 decision persistence | File-adapter cross-session tests (`test/conformance/file-adapter.test.ts`), two Host instances at the same rootDir observing each other's writes | implemented |
| 3 reversal supersession | Scenario 1 + 2 (`test/simulation/s1.test.ts`, `s2.test.ts`) | implemented |
| 4 calibration | Promotion engine thresholds (`src/promotion/policy.ts`) enforce confidence * consensus * validation; 4-month+ tracking is still real-usage work | partial (simulation green, real-usage not yet tracked) |
| 5 no contradictions | Arbitration stack (`src/arbitration/`) runs at write time; scenario 5 colluding principals bounds collusion at L2 | implemented |
| 6 coherent summarization | `SUMMARIZE_DIGEST` schema (`src/schemas/index.ts`) wired to the judge; not yet driven by a recurring job | partial |
| 7 scope isolation | Principal `permitted_scopes` honored by `PrincipalStore.permits`; cross-workspace happy path not yet a dedicated scenario | partial |
| 8 stale fade | Scenario 4 TTL (`test/simulation/s4-ttl.test.ts`) + loop TTL pass (`src/loop/ttl.ts`); decay skips `taint !== 'clean'` so stale atoms stay out | implemented |

## Concrete signals this is working in real life

Not in simulation, in actual sustained use:

- The user stops needing to re-explain settled decisions at the start of sessions.
- The user stops getting contradictory suggestions across sessions on the same topic.
- The user says "remember when we decided X" and the system retrieves the correct atom.
- The user does NOT say "why did you forget X" or "why are you suggesting Y when we agreed on Z".

Last one is the real-world canary. Count of "why are you contradicting yourself" moments per month should trend to zero.
