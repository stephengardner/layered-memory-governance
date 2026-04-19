# Simulation Harness

The simulation IS the spec. If the system cannot pass, nothing downstream matters.

## Goal

Run the memory system against a simulated world where ground truth is known, events change that truth over time, and agents interact with the memory under their own loop. Measure whether the system converges on truth, catches contradictions, and stays calibrated.

## Principle

**No simulation without a ground-truth oracle.** A self-prompted agent loop without ground truth only measures artifact generation, not memory quality. The oracle is what makes this a test and not a vibe session.

## World model

A simulated "project" with deterministic state:

```
world:
  project_name: "acme"
  stack:
    language: "python"
    framework: "fastapi"
    database: "postgres"
  team:
    members: [...]
  constraints:
    merge_freeze_until: null
    security_review_required_for: [...]
  code:
    files: { path -> content }
  decisions:
    - id, summary, made_at, made_by, alternatives_considered, reason
  time: ISO-8601 simulated clock
```

Every field is the oracle. A memory that says "database is postgres" is true iff `world.stack.database == "postgres"` at query time.

## Event stream

Events are the only way world state changes. Typed, time-stamped, scripted per scenario.

```
event types:
  DECISION_MADE            agents observe it in-session
  DECISION_REVERSED        world.stack changes; older atoms become stale
  CODE_CHANGED             file contents update
  CONSTRAINT_ADDED         e.g. merge_freeze_until = T+7d
  CONSTRAINT_EXPIRED       freeze lifts at T+7d
  NOISE                    irrelevant fact injected (tests filtering)
  AMBIGUOUS                two plausible observations of same event
  ADVERSARIAL              injected wrong observation (tests validation / arbitration)
```

## Agent loop

```
for tick in 1..N:
  event = scenario.next_event(world.time)
  apply(world, event)

  # Observe
  observations = agent.observe(world, event, principal)
  for obs in observations:
    palace.ingest(obs, principal=principal)

  # Optional: retrieve + decide
  if tick % retrieval_cadence == 0:
    question = scenario.next_question(world.time)
    retrieved = palace.search(question, time=world.time)
    answer = agent.decide(question, retrieved, principal)
    truth = world.oracle(question)
    metrics.record(
      accuracy = (answer == truth),
      grounding = count_retrieved_referenced(answer, retrieved),
      cost = measure_tokens(agent)
    )

  # Governance cycles
  if tick % arbitration_cadence == 0:
    conflicts = palace.detect_conflicts()
    for c in conflicts:
      palace.arbitrate(c)

  if tick % decay_cadence == 0:
    palace.decay_all()

  if tick % promotion_cadence == 0:
    for candidate in palace.promotion_candidates():
      if should_auto_merge(candidate):
        canon.merge(candidate.proposal)
      else:
        review_queue.push(candidate)

# Final evaluation
report = metrics.summarize()
report.canon_drift = diff(canon.current, world.oracle.canon_equivalent)
report.auto_merge_reversal_rate = count(reverted) / count(auto_merged)
```

## Scenarios

### Scenario 1: self-bootstrap (mandatory first test)

World starts empty. Event stream IS this conversation's turn sequence.

```
t=1  user: "/compact is broken"
       agent observes: "user reports /compact is blocked by precompact hook"
t=2  agent: "PreCompact block is terminal"     (L1 observation)
t=3  user: "will this still work? does it save?"
       agent revises: "claude-curated save no longer triggers via block"
       EXPECTED: the prior L1 atom should be superseded, not duplicated
t=4  user: "Stop hook error is a literal problem"
       EXPECTED: the prior "error display is intentional" atom must be
       retracted, not coexist
t=5  decision: "hook_stop returns pass-through, use python-driven mining"
       EXPECTED: promote to L2; supersede the block-semantics atoms
...
```

If the system cannot represent "I was wrong, retract the earlier atom" correctly on this canonical conversation, nothing works.

### Scenario 2: decision reversal over time

Tick 1: DECISION_MADE "we use Redux".
Tick 50: DECISION_REVERSED "we moved to Zustand".
Tick 100: question "what state library do we use?"

EXPECTED: answer is Zustand. The Redux atom is superseded but retained for audit. A question about history ("what did we use to use?") retrieves both with temporal context.

### Scenario 3: merge freeze with TTL

Tick 1: CONSTRAINT_ADDED merge_freeze_until=Tick+20.
Tick 10: question "is merge freeze active?"  => EXPECTED yes.
Tick 30: question "is merge freeze active?"  => EXPECTED no (atom expired).

Tests TTL / expiry as first-class.

### Scenario 4: adversarial injection

Tick 50: ADVERSARIAL event injects "we use MongoDB".
Tick 51: question "what database?" => EXPECTED postgres.

Tests arbitration (source-rank) and validation (if a validator exists).

### Scenario 5: multi-agent disagreement

Agents A and B observe the same CODE_CHANGED event differently due to injected noise.
EXPECTED: conflict detected, arbitration run, loser superseded, winner promoted with reduced consensus until confirmed.

### Scenario 6: principal compromise

Tick 1..50: principal P writes normally.
Tick 51: mark P compromised at T=40.
EXPECTED: atoms from P since tick 40 are tainted; derived atoms cascade; canon edits from that lineage auto-revert PR opens.

## Metrics

Primary:
- **Accuracy** at retrieval: does the answer match the oracle?
- **Grounding**: what % of answers cite retrieved atoms (vs fresh invention)?
- **Canon drift**: distance between L3 canon and oracle over time.
- **Auto-merge reversal rate**: fraction of auto-merged proposals later reverted.

Secondary:
- Conflict detection rate and resolution latency.
- Staleness ratio: % of top-retrieved atoms that the oracle shows are outdated.
- Cost per useful retrieval.

Health:
- Read-rate-30d: fraction of atoms ever retrieved in their lifetime.
- Review queue depth over time.
- Taint propagation correctness.

## Non-goals for V0 simulation

- Visual dashboards (logs are enough).
- Multi-user scoping (single user, N agents).
- Realistic event distributions (hand-scripted scenarios first, stochastic later).

## Implementation order

1. **World model + oracle**. Pure data structures.
2. **Scenario 1 (self-bootstrap)**. The hardest test, the one that matters.
3. **Minimal palace adapter** that implements atom schema over chromadb or flat JSON.
4. **Agent loop driver**. Can initially be a scripted agent, not an LLM call.
5. **Metrics + report generator**.
6. **Add scenarios 2-6 incrementally**.
7. **Swap scripted agent for actual LLM-driven agent (`claude -p --bare`)** once determinism is not the blocker.

## Self-prompt loop ("literally creating itself")

Using the `/loop` skill (or cron) to run a Claude Code session every N minutes that:
- Reads the repo (`docs/`, `design/`)
- Consults open-questions.md
- Proposes an answer / revision as a diff
- Humans / reviewer approves

That loop is itself an agent under a principal, and its writes are subject to the same governance as anything else. This is the recursive stability test: can the system refine its own design without going off the rails?

Kill switch for the self-loop: a file `<rootDir>/STOP` halts the loop. Checked at the start of every tick.
