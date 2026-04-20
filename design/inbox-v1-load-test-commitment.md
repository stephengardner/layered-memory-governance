# Inbox V1: 50-actor load test commitment

**Source plan:** `plan-v2-1-hardening-circuit-breaker-policy-re-cto-actor-20260420115050`
(itself revising `plan-revised-inbox-hybrid-wake-write-time-rat-cto-actor-20260420110310`).

**Canon-level commitment, not a follow-up ticket.** Tickets slip; canon doesn't.
Per `dev-forward-thinking-no-regrets`, discovering NOTIFY drops or DB saturation after
PR E ships is exactly the regret the directive names.

## What the gate is

PR E of the inbox V1 sequence (`SubActorRegistry` + the two named 55c consumers:
`pr-landing-actor` and `auditor-actor`) **cannot be approved for merge until this
load-test suite is green against a real Postgres AtomStore.**

Indie floor is explicitly outside the gate: deployments on the file AtomStore never
hit this test. Only the Postgres-graduation PR is gated. This preserves
`dev-indie-floor-org-ceiling`  -  solo dev ships the same shape without paying the
load-test cost.

## Where it lives

`test/load/actor-message/run-50-actor.ts`

The file AtomStore test suite (`npm test`) does not include this directory; a dedicated
`npm run test:load` harness runs it. Default CI does not gate on it either  -  the gate
is the PR E review path, enforced as a canon-documented requirement on that specific PR.

## Workload

- **50 concurrent actor principals**, each acting as both a sender and a receiver of
  `actor-message` atoms. Each principal runs its own observe/classify/propose/apply
  loop via `runActor` against a shared Postgres AtomStore.
- **Load-test principal rate overrides.** The framework default `pol-actor-message-rate`
  (10 msgs/min, burst 20) would throttle any sustained load test below 1 msg/3s and
  leave this suite testing only the rate limiter, not the substrate. The test instead
  provisions a per-principal override atom for each of the 50 load-test principals
  granting `tokens_per_minute: 200, burst_capacity: 50`. Non-load-test principals
  continue under the default. This is the same per-principal override mechanism any
  deployment uses for a known-high-volume sender (e.g. a webhook adapter) and is
  itself exercised as part of the test.
- **Sustained rate: 2 msgs/sec/actor (100 msgs/sec aggregate) for 30 minutes.** At
  120 msgs/min/actor this runs below the override bucket ceiling (200/min); no
  sender should be denied during the sustained segment. Verifies substrate
  throughput under steady load, not the rate limiter.
- **Burst segment: 10 msgs/sec/actor (500 msgs/sec aggregate) for 60s embedded at
  minute 5.** 600 msgs/min/actor exceeds the override's 200/min bucket; the bucket
  denies; 3 denials inside `window_ms=300_000` trip the circuit breaker. Verifies
  that (a) trips happen when expected, (b) untripped senders continue unaffected,
  (c) the atom-store write rate ceiling holds under the denied load.
- **Deadline-imminent injections: 1 msg/min/actor** carrying a `deadline_ts` value
  within 30s of `now`. Tests that the `pol-inbox-poll-cadence` `deadline_imminent_poll_ms`
  cadence engages and the message is picked up inside the poll interval even if
  NOTIFY drops.
- **Inbox depth distribution: Zipfian, most principals 0-5 unread, tail to 50 unread.**
  Matches expected operational shape where a handful of principals get most of the
  chatter; exercises read-path latency at tail depth.

## Pass / fail criteria

| Metric | Pass |
|---|---|
| Message pickup p50 latency (sender-write → receiver-listUnread) | ≤ 500 ms |
| Message pickup p99 latency | ≤ 2 s |
| Sustained write throughput (atoms/sec) | ≥ 500 |
| False rate-limit denials (should-have-succeeded rejections) | < 1 % of total writes |
| Postgres CPU, sustained segment | < 60 % |
| Postgres CPU, burst peak | < 80 % |
| Silent drops (messages never seen by receiver) | 0 |
| `.lag/STOP` sentinel effective (pickup halts) under peak | ≤ 2 s |

## Hardware baseline

The canonical reference profile for the pass/fail targets:

- **Postgres: 2 vCPU, 8 GB RAM, 100 GB SSD** (matches the smallest RDS/Cloud SQL
  production tier most consumers hit).
- **Application workers: 2 vCPU, 4 GB RAM** per process; one process holding all 50
  actor principals is the single-node reference.
- **Network: same VPC, ≤ 1 ms RTT between worker and Postgres.**

Deployments on beefier or smaller hardware re-run the suite against their own profile;
the targets above are the minimum a Postgres-graduated deployment must beat on
reference hardware before PR E approval.

## What this test does not cover (explicit non-scope)

- **Multi-node worker scaling.** Sharding a single inbox across workers is a
  Phase 56+ concern; this test runs all 50 actors on one worker.
- **Cross-region latency.** Single VPC assumption. Multi-region is out of scope.
- **Failure-injection.** Postgres kill, NOTIFY backlog, worker crash: separate suite.
- **Adversarial load.** A malicious principal writing at max speed is covered by the
  circuit breaker, not by this throughput test.

## How PR E approval integrates the result

1. Load-test suite is run on reference hardware against a Postgres build of the
   AtomStore.
2. The run produces a summary atom with the following **required** provenance
   contract (per the `inv-provenance-every-write` canon directive; every atom
   must carry a source chain):

   | Field | Value |
   |---|---|
   | `type` | `observation` |
   | `layer` | `L1` |
   | `principal_id` | the load-test harness principal, seeded in `.lag/principals/load-test-harness.json` before the run |
   | `provenance.kind` | `'agent-observed'` (the harness is an agent, the numbers are observations) |
   | `provenance.source.tool` | `'load-test-harness'` |
   | `provenance.source.session_id` | the run id, **must** match `metadata.load_test_run_id` so the two bindings stay coherent |
   | `provenance.source.agent_id` | `'load-test-harness'` |
   | `provenance.derived_from` | `[]` (the harness reads the live AtomStore, not another atom; the source chain terminates here) |
   | `metadata.load_test_run_id` | stable, unique per run; same value as `provenance.source.session_id` |
   | `metadata.passed` | boolean |
   | `metadata.metrics` | object carrying every metric from the pass/fail table, including failure detail if `metadata.passed === false` |

   Including `session_id` explicitly satisfies D-mbb-V1-4 (source-chain explorer) and
   D-mbb-V2-2 (importance-timeline projection) which both depend on session_id
   being present on every atom the pipeline produces.

3. PR E's description cites the observation atom id.
4. Operator approval of PR E requires the cited observation to exist, have the
   provenance contract above, and report `metadata.passed === true`.

If the first run does not pass, the regression is in the plan or implementation,
not the test. Revise the plan and re-run before attempting PR E.

## Provenance

- `plan-v2-1-hardening-circuit-breaker-policy-re-cto-actor-20260420115050`: the plan
  that promoted this load-test from a ticket to a canon commitment.
- `dev-forward-thinking-no-regrets`: the directive requiring the test be canon-level.
- `dev-indie-floor-org-ceiling`: the reason the file AtomStore is outside the gate.
- `inv-kill-switch-first`: the reason `.lag/STOP` effectiveness is measured.
- `dev-extreme-rigor-and-research`: the reason every default and threshold in this
  doc is accompanied by a number, not a vibe.
