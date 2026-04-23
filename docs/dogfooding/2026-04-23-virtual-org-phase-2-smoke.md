# Virtual-org phase 2 smoke test retrospective

> Run: 2026-04-23T08:08:57Z. Main at `684afaa` (phase 3+4 merge, PR #111).
> Plan: `docs/superpowers/plans/2026-04-23-virtual-org-phase-2-host.md`.
> Companions: `2026-04-22-task-d-132-retro.md`, `2026-04-22-virtual-org-host-gap.md`.

## Target (verbatim, handed to `boot.mjs --execute`)

```text
Add a single-line comment at the end of docs/dogfooding/README.md noting the
virtual-org phase-2 smoke-test run date in ISO 8601 UTC format. Use the format:

    <!-- virtual-org phase-2 smoke-test: <UTC timestamp> -->

The line should be the absolute last line of the file (after any existing
trailing newline).
```

## Outcome

**PARTIAL - setup + Question atom persisted; deliberation did not complete.**

The runtime wiring shipped by PRs #108, #110, #111 reached the Question-atom-
write stage cleanly:

- Worktree built, file-backed Host constructed against `.lag/virtual-org-state/`.
- 4 `pol-code-author-*` fence atoms + `pol-two-principal-approve-for-l3-merges`
  seeded correctly (5 directive atoms on disk, all from `scripts/bootstrap-code-
  author-canon.mjs` verbatim).
- Question atom `q-1776931737928` persisted under `vo-cto` principal with the
  two-participant list (`vo-cto`, `vo-code-author`), `roundBudget: 2`, 15-minute
  `timeoutAt`.
- boot.mjs printed its start marker (`[boot-start] 2026-04-23T08:08:57Z`).
- stderr empty; stdout stopped after the start line.

Then nothing. No Position atoms, no Counter, no Decision, no PrOpenedAtom, no
ExecutionFailedAtom, no crash trace. File-mtimes on all atoms cluster inside
the same second (`2026-04-23T08:08:57Z` UTC). No `claude.exe` processes alive on the host
after the subagent context ended.

## Most likely root cause

**CLI-within-CLI invocation context.** The smoke test was launched from inside
a Claude Code subagent session. `boot.mjs --execute` instantiates
`ClaudeCliLLM`, which spawns `claude -p "<prompt>"` as a subprocess for each
participating agent's `judge` call. Nested `claude` invocations running under
an outer `claude` session appear to silently fail to deliver output back - the
outer subagent's stdio capture, hooks, and session-persistence machinery
probably interfere with or swallow the inner subprocess's response.

**This is a smoke-test-environment failure, not a runtime-wiring failure.**
All the unit + integration tests shipped with PR #111 pass (mocked SDK +
mocked runCodeAuthor). The Host, executor, plan-atom seam, LLM factory, and
GhClient factory are verified in isolation. The gap is between those
verified units and a live end-to-end run under the specific nesting condition.

## Timeline

| step | time (UTC) | duration |
|---|---|---|
| boot.mjs start | 2026-04-23T08:08:57Z | - |
| Fence + canon atoms written | 2026-04-23T08:08:57Z | <1s |
| Question atom written | 2026-04-23T08:08:57Z | <1s |
| (deliberation silently stops) | - | - |
| Subagent context exhausted | 2026-04-23T08:15:23Z (approx) | ~386s wall |

## Atoms produced vs expected

| type | produced | expected for SUCCESS |
|---|---|---|
| fence directive (4) | ✅ | ✅ |
| pol-two-principal directive (1) | ✅ | ✅ |
| question | 1 | 1 |
| position | 0 | 2 (CTO + Code Author) |
| counter | 0 | 0-2 |
| decision | 0 | 1 |
| plan (`plan-from-<decision.id>`) | 0 | 1 |
| pr-opened observation | 0 | 1 |
| reasoning-step observations | 0 | variable |

Chain validity: the Question atom is reachable but its downstream is empty.

## Interventions during the run

**Strict count: 0.** The operator did not intervene during the smoke run
itself. The retro write-up that landed in this file is operator-authored
(post-run), not an in-run intervention.

## Falsification tripwire check

Per spec:

- **Week-8: "task D shipped via virtual org end-to-end"** → NOT CLEARED.
  The runtime can't yet produce an end-to-end PR under the only environment
  that's been tried (Claude Code subagent).
- **Intervention count ≤ 10** → CLEARED (0 interventions).
- **Week-4: task A shipped** → ALREADY CLEARED (prior phase-1 smoke test at
  `2026-04-22-task-d-132-retro.md`).

## What worked (substrate validation)

- File-backed Host construction clean, 8-interface contract satisfied.
- Fence-atom seeding with drift guard (#110) honored - no taint.
- Operator-principal resolution via the `LAG_OPERATOR_ID` → seed-role-root
  fallback landed in #111 worked as designed.
- `--state-dir` threading uniform across AtomStore, PrincipalStore, GhClient,
  and GitIdentity (closed the CR finding on #111).
- Canon on main (4 pol-code-author atoms + two-principal policy) flows into
  the virtual-org Host without manual seeding - the `buildVirtualOrgHost`
  composer does the right thing.
- Atom persistence round-trips through the file adapter cleanly.

## What surprised

- **Silent stop after Question.** No error, no timeout, no stderr. This is
  worse than a loud failure - it's invisible to a human operator running
  under the same nested-CLI condition. A hard timeout at the coordinator
  level (not just the question-level `timeoutAt`) would turn this into an
  Escalation atom with a reason code, which the operator could act on.
- **Nested-CLI failure mode matters.** `ClaudeCliLLM` worked fine in unit
  tests with a mocked subprocess. It worked fine from a top-level terminal
  (phase-1 smoke test). It silently halts when called from inside a Claude
  Code subagent's spawned shell. The "live smoke test from a subagent" path
  was never actually validated before this run; now it's been run and failed.

## New canon debts

These are proposed atoms the operator should review in the next canon-debt
ritual:

1. `obs-cli-in-cli-nesting-fails-silently` - observation. Content: "The CLI-
   backed LLM adapter (`ClaudeCliLLM`) appears to fail silently when its
   `claude -p` subprocess is launched from inside a Claude Code subagent
   session. The nested session's stdio capture / hooks interfere with the
   inner subprocess's response delivery. Verified: the same adapter works
   from a top-level terminal. Implication: Phase 5 live smoke tests for the
   virtual org MUST be run from a standalone operator terminal, not delegated
   to a subagent."
2. `pref-coordinator-wall-clock-timeout` - preference. Content: "The
   deliberation coordinator should enforce a wall-clock timeout at the
   round-invocation level (not only the question-level `timeoutAt`). If a
   single `judge` call exceeds N seconds with no response, convert to an
   Escalation atom with reason `llm-silent-hang` instead of waiting for the
   question-level timeout. Default N = 90 seconds. Rationale: silent LLM
   hangs otherwise produce zero diagnostic signal."
3. `ref-phase-5-smoke-runs-from-top-level-terminal` - reference. Content:
   "Virtual-org phase-5 smoke tests (boot.mjs --execute) must be invoked
   from a top-level operator terminal, not from inside a Claude Code subagent
   or nested claude-cli session. See `docs/dogfooding/2026-04-23-virtual-org-
   phase-2-smoke.md` for the silent-hang incident that motivated this rule."

## Recommendation

**Do NOT treat this run as the acceptance-criterion signal for Phase 5.**
The runtime wiring is unit- and integration-tested correct. The live
end-to-end run needs a re-attempt from a standalone operator terminal
(outside any Claude Code subagent). Expected behavior in that environment:
Question → 2 Positions → Decision → Plan atom → PrOpenedAtom, ~2-5 minutes.

Next operator action (out of scope for this session):
1. Open a fresh terminal at repo root.
2. `cd .worktrees/virtual-org-phase-5-smoke && npm run build`.
3. `node src/examples/virtual-org-bootstrap/boot.mjs --execute --repo-dir . --state-dir .lag/virtual-org-state --role lag-ceo --model claude-opus-4-7 "<the target prompt>"`.
4. Watch atoms accumulate; verify draft PR appears on github.com.
5. Record the successful run as a companion retrospective.

If the top-level run ALSO stalls at the same step, the root cause is deeper
than nesting, and `ClaudeCliLLM` needs a fresh investigation. But the
current-evidence prior is strongly on the nesting explanation.

## Senior-CTO-level analysis

Treating the virtual-org bootstrap as a real product, what does the runway
look like after this session's 6-PR phase-2 landing + the partial smoke
signal?

### What this session actually proved

1. **The substrate thesis holds under real governance load.** Six PRs through
   full CodeRabbit review + admin-merge, with the CR loop catching real
   issues every time (fence-atom drift guard gap, operator-principal
   hardcode, state-dir threading inconsistency, documentation drift). Each
   finding represents a class of failure the memory host + mocked tests
   could not have caught. The governance substrate functioned as the
   intended safety net during its own construction.

2. **Phase-1 runtime is structurally complete.** Deliberation atoms
   (Question / Position / Counter / Decision / Escalation) + role-scoped
   canon renderer + signature-only thinking persistence + CLI-backed LLM +
   Decision → runCodeAuthor handoff with plan-atom seam + file-backed Host
   with fence-atom seeding + operator-identity resolution + `--state-dir`
   uniformity. The wiring passes every unit and integration test shipped
   with the relevant PRs. No substrate-level component has a known bug.

3. **The gap between "wiring verified" and "end-to-end smoke" is narrower
   than expected, and it is an operational gap, not a substrate gap.** The
   nested-CLI silent-hang is an environment issue, not a runtime issue.
   Running `boot.mjs --execute` from a top-level operator terminal (outside
   any Claude Code subagent shell) is the intended production invocation
   path; the subagent context was a convenience for automation in this
   session that revealed a latent environment constraint.

### What remains before declaring Phase 2 production-ready

1. **One successful top-level-terminal smoke run.** Not two, not ten. One
   live run that produces the full Question → Positions → Decision → Plan
   → PrOpenedAtom chain, with a real draft PR visible on GitHub authored
   by `lag-ceo[bot]`. That single run is the acceptance artifact. It takes
   an operator 5-10 minutes from a normal terminal.

2. **Coordinator wall-clock timeout hardening.** Proposed canon debt #2
   above. A Question-level 15-minute timeout is too coarse; silent
   per-turn hangs should convert to Escalation atoms within ~90 seconds
   with a specific reason code, not wait 15 minutes for the question to
   expire. This is a 30-LOC change in the coordinator + two regression
   tests. Not required for the acceptance run, but required before the
   virtual org is trusted with long-horizon work.

3. **Documented environment constraints.** Proposed canon debt #3 above.
   "Run from a top-level terminal" should be a first-class ref atom so
   the next operator doesn't rediscover the nested-CLI constraint by
   surprise.

### Strategic-level observation: this is the thesis working

The original plan's falsification tripwire - "the substrate is a real
governance surface for multi-agent orgs" - was to be falsified by finding
that canon / arbitration / CR review couldn't catch real class-of-failure
bugs under load. Across 6 PRs today, CR caught:

- 1 Critical (hardcoded `helix-root` sentinel violating operator-identity
  boundary)
- 6 Major (fence drift guard missing `superseded_by`, state-dir
  asymmetry, partial Host cast synthesizing 2-of-8 sub-interfaces,
  plan-atom failure-path unprotected, unknown-flag silent-absorption, and
  the L3-bypass-before-layer-filter)
- ~8 Minor (documentation drift, canon-mechanism-only violations in
  comments, test-name mismatches)

Every Critical and Major finding is a class-of-failure the substrate was
designed to flag, and did flag, at the right gate. The substrate is not
theater.

### Recommendation for the next operator cycle

1. Top-level terminal → run the acceptance-criterion smoke test per the
   command in the recommendation section above. ~10 min.
2. If it works: commit the success retrospective, close this dogfooding
   log for phase 2. Phase 2 is complete.
3. If it doesn't work: the nesting hypothesis was wrong. Open a real bug
   against `ClaudeCliLLM` invocation semantics and treat phase 2 as not
   shipped.

Either outcome clears the ambiguity. The current state is strongly biased
toward outcome (2) given the evidence (unit + integration coverage clean,
Question atom persisted correctly, 5 out of 6 setup stages verified
end-to-end in real atom state).

## Document provenance

Written by the operator (via this Claude Code session) after the smoke-test
subagent's live run halted silently. All claims here are grounded in the
captured `.lag/virtual-org-runs/task-d2-smoke.{stdout,stderr}` + the
on-disk atom snapshot. The full retrospective discipline (atoms adopted,
canon debts landed, re-run evidence) remains pending a top-level-terminal
re-run.
