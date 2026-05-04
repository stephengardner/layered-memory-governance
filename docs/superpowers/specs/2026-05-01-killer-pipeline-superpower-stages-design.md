# Killer pipeline: superpower-driven stages design

> **Status:** Draft for implementer hand-off (operator carte-blanche on tokens; "industry-leading" mandate).

## Summary

The current deep-planning pipeline (`src/runtime/planning-pipeline/runner.ts`, 5-stage default) walks brainstorm -> spec -> plan -> review -> dispatch as a sequence of single-shot `host.llm.judge()` calls with zod-validated payloads. Each stage produces one JSON blob. The output quality reflects the constraint: a single 30-second LLM call cannot read files, run greps, follow chains of reasoning, or revise its own output. The dogfeeds of 2026-04-30 and 2026-05-01 surfaced this directly: brainstorms paraphrased instead of surveying alternatives, plans confabulated atom ids, dispatch produced PRs that needed 3+ CR rounds.

This spec replaces each stage's single judgment call with a **dispatched sub-agent run** invoked through the existing `AgentLoopAdapter` substrate (PR1 from `feat/agentic-actor-loop`, lives at `src/substrate/agent-loop.ts` and `examples/agent-loops/claude-code/`). Each stage gets:

- Its own bounded workspace (read-only or read-write per stage).
- A canon-resolved tool policy (`pol-llm-tool-policy-<principal-id>`).
- A bundled superpower skill prompt that drives multi-turn reasoning.
- An explicit canon-binding step at session start: the sub-agent reads `applicable_canon` for its principal before producing output.
- Full agent-session + agent-turn provenance written to atoms during the session.
- A pipeline-stage-event atom emitted at start, end, canon-applied, and per LLM call.
- A canon-audit checkpoint between produce-output and persist-output (per `dev-implementation-canon-audit-loop`).

The substrate seam (`PlanningStage` interface in `src/runtime/planning-pipeline/types.ts`) does NOT change. The runner still walks `ReadonlyArray<PlanningStage>` sequentially. What changes is the implementation of `stage.run()` for each of the 5 reference stages: today it calls `host.llm.judge` once; under this design it dispatches an agent-loop run with a stage-specific skill prompt + tool policy + workspace.

This is **substrate-pure**: the runner is unchanged, no new substrate types, no new policy primitives. The stages live in `examples/planning-stages/` and compose new wiring the substrate already supports. Org-ceiling deployments that prefer the single-judgment shape continue to compose the existing adapters; deployments that opt into the killer-pipeline mode register the agentic adapters via canon policy.

## Goals

1. **Phenomenal stage output.** A brainstorm survey reads as something a senior engineer wrote after an hour of investigation, not 30 seconds of pattern-matching. A spec reads as a design doc someone would ship. A plan decomposes work into bite-sized TDD tasks with exact paths and complete code samples. A review actually verifies cited paths and atom ids by walking them. A dispatch hands off only when the upstream chain is verifiably grounded.
2. **Full observability.** Every stage's reasoning, tool calls, canon read, and intermediate state is queryable from atoms alone. The console deliberation-trail surface renders the full chain.
3. **Substrate-pure.** No new types in `src/`. The `PlanningStage` interface unchanged. The runner unchanged. New shape lives entirely in adapter implementations + canon policy.
4. **Indie-floor preserved.** Default mode stays `single-pass` per `dev-pipeline-default-mode`. The killer-pipeline activates only on explicit `--mode=substrate-deep` or org-ceiling canon override.
5. **Kill-switch + budget contracts inherit unchanged.** The runner already polls killswitch before every transition + every write; that behavior holds for whatever the stage does internally.

## Non-goals

- Replacing the substrate's `host.llm.judge` primitive. It stays as the cheap single-shot path for tactical decisions.
- Building a new orchestration framework. Agent loops already exist (PR1+PR2+PR3 trilogy from April 25).
- Speculative dial infrastructure (per `dev-apex-tunable-trade-off-dials-future-seam`). The mode toggle is a CLI opt-in (`--mode=substrate-deep` on `run-cto-actor.mjs`) plus the canon authorization stack (`pol-pipeline-default-mode` + per-scope overrides). Indie-floor default stays `single-pass` so a typo-fix never surprise-pays the deep-pipeline tax; org-ceiling deployments raise the dial via a higher-priority policy atom that flips the default for their scope. Both layers are required: the CLI flag selects the path on a given invocation, and canon authorizes the principal + scope to take that path. There is no third "free-form runtime knob"; that surface is reserved for a future apex-tunable dial via the canon-defined ENUM mechanism.

## Architecture

### Stage as agent-loop run

Today (`examples/planning-stages/brainstorm/index.ts`):
```ts
async function runBrainstorm(input: StageInput<unknown>): Promise<StageOutput<BrainstormPayload>> {
  const result = await input.host.llm.judge<BrainstormPayload>(
    BRAINSTORM_JUDGE_SCHEMA,
    BRAINSTORM_SYSTEM_PROMPT,
    { /* data block */ },
    { model: 'default', sandboxed: true, max_budget_usd: 1.0 },
  );
  return { value: result.output, cost_usd: result.output.cost_usd, ... };
}
```

Under this design (the same module's `run` function, replaced):
```ts
async function runBrainstorm(input: StageInput<unknown>): Promise<StageOutput<BrainstormPayload>> {
  const session = await runStageAgentLoop(input, {
    stageName: 'brainstorm-stage',
    stagePrincipal: 'brainstorm-actor' as PrincipalId,
    skillName: 'superpowers:brainstorming',
    promptBuilder: buildBrainstormPrompt,
    outputSchema: brainstormPayloadSchema,
    workspaceMode: 'read-only',
    canonBindMode: 'load-applicable',
  });
  return session.toStageOutput('brainstorm-output');
}
```

`runStageAgentLoop` is a new thin helper in `examples/planning-stages/lib/run-stage-agent-loop.ts`. It composes the existing primitives:

1. Resolves the per-principal tool policy via `loadLlmToolPolicy(host.atoms, stagePrincipal)`.
2. Acquires a workspace via the `WorkspaceProvider` registered for stage runs (defaults to `EphemeralWorkspaceProvider` with the principal's bot creds, read-only mode for non-mutating stages).
3. Reads the principal's `applicable_canon` via `host.canon.applicable({ principal_id: stagePrincipal, layer: 'L3' })` and writes a `pipeline-stage-event` atom with `transition: 'canon-bound'` carrying the atom-id list.
4. Builds the agent prompt as `[skill-bundle, canon-summary, stage-context, output-contract]` -- skill-bundle is the literal contents of the superpowers skill markdown plus its supporting prompts (e.g., `spec-document-reviewer-prompt.md` for brainstorming). The skill markdown lives outside the repo (in `~/.claude/plugins/cache/.../superpowers/...`) so the helper resolves the path from a configurable root, falling back to a vendored copy under `examples/planning-stages/skills/` if the operator's machine doesn't have the plugin installed.
5. Invokes the configured `AgentLoopAdapter.run(...)` with this prompt, the resolved tool policy, the stage's budget cap, and the workspace. The adapter writes `agent-session` + `agent-turn` atoms during the run.
6. After the loop returns, runs a canon-audit sub-agent over the output (per `dev-implementation-canon-audit-loop`): a small follow-up agent-loop run on the same workspace with prompt "Audit this output against canon and the spec; return a JSON verdict {approved: bool, findings: [...]}".
7. Persists the audit outcome as a `pipeline-stage-event` with `transition: 'canon-audit-complete'`.
8. Parses the agent-loop's final output against the stage's zod schema. If schema-fail, fail the stage (the runner halts on schema-fail at `runner.ts:421`).
9. Returns a `StageOutput` whose `cost_usd` is the agent-session's `budget_consumed.usd`, whose `duration_ms` is the wall clock, and whose `value` is the validated payload.

The runner machinery downstream of `stage.run()` (schema validation, budget check, atom persistence, audit findings, HIL gate, auto-approve, exit-event emission) is unchanged. The only material difference is `stage.run()` now produces a queryable session-tree projection instead of a single LLM-call telemetry record.

### Per-stage skill composition

| Stage | Principal | Skill bundle | Workspace | Tool policy | Output |
|---|---|---|---|---|---|
| brainstorm-stage | `brainstorm-actor` | `superpowers:brainstorming` (incl. spec-document-reviewer loop) | read-only | Read+Grep+Glob (already in canon) | `BrainstormPayload` |
| spec-stage | `spec-author` | superpowers writing-clearly + spec-document-reviewer prompts | read-only | Read+Grep+Glob | `SpecPayload` |
| plan-stage | `cto-actor` (re-used; planning principal) | `superpowers:writing-plans` (bite-sized TDD task decomposition) | read-only | Read+Grep+Glob | `PlanPayload` |
| review-stage | `pipeline-auditor` | `superpowers:requesting-code-review` adapted to audit a plan against canon | read-only | Read+Grep+Glob | `ReviewReportPayload` |
| dispatch-stage | `plan-dispatcher` | (no skill bundle: this is a substrate-mediated handoff via SubActorRegistry) | n/a | n/a | `DispatchRecordPayload` |

The dispatch-stage stays as the existing `createDispatchStage(registry)` shape -- it's a deterministic handoff that hands an approved plan to a registered sub-actor (e.g. `code-author`). The killer-pipeline upgrade applies to the FOUR upstream stages where reasoning quality dominates.

### Canon-binding step

Per `inv-governance-before-autonomy` and `dev-implementation-canon-audit-loop`, every stage's sub-agent must:

1. **At session start**: load `applicable_canon(stagePrincipal, L3, 'project')` and emit a `pipeline-stage-event` with `transition: 'canon-bound'` listing the atom ids. The agent's first turn must echo "I have read N canon directives covering: [list]" so the prompt loop is verifiable.
2. **Mid-session**: the agent may re-read canon as needed via `Read` tool against `.lag/atoms/<id>.json` -- the canon-audit sub-agent expects to see those reads in the agent-turn atoms.
3. **Pre-output**: the agent must emit a "self-audit checkpoint" turn naming which canon directives it applied to its output. This is a prompt-side discipline; the verifier runs in the audit step below.
4. **Post-output canon-audit**: a fresh small sub-agent loop runs the canon-audit prompt: "Given this stage output, the applicable canon, and the operator-intent, list any directive the output violates. Return {findings: [...]}." Critical findings halt the stage via the existing audit mechanism.

### Pipeline-stage-event atom: extended transitions

The existing atom type accepts: `enter | exit-success | exit-failure | hil-pause | hil-resume`.

We extend the union (atom-shapes.ts mint helper + zod enum) with:

- `canon-bound` -- canon load complete, atom-ids in metadata.
- `canon-audit-complete` -- post-output audit ran; verdict + findings on metadata.
- `agent-turn` -- per LLM call inside the stage's agent loop; the pipeline-stage-event metadata carries only the index fields (`agent_turn_atom_id`, `turn_index`, plus the standard `transition`, `duration_ms`, `cost_usd`). Richer per-turn telemetry (`tools_used`, `tokens_in`, `tokens_out`, `latency_ms`, `failure`) lives on the agent-turn ATOM itself per the substrate's `AgentTurnMeta` contract; the pipeline-stage-event entry is a thin index pointing back at the agent-turn atom for console-side rendering ergonomics.

This keeps the substrate type union narrow but the projection rich. The console deliberation-trail surface already iterates all `pipeline-stage-event` atoms by pipeline_id; it just needs to render the new transitions.

### Backwards compatibility

Default mode stays `single-pass` per `dev-pipeline-default-mode`. The agentic stage adapters live alongside the existing single-shot adapters; the canon `pol-planning-pipeline-stages-default` policy now resolves to two distinct lists:

- **Indie floor** (no override): single-shot reference adapters (current behavior).
- **Substrate-deep skill-driven** (org-ceiling or explicit operator opt-in): agentic adapters.

The selection lives in canon: `pol-planning-pipeline-stage-implementations-<scope>` with field `mode: 'single-shot' | 'agentic'` per stage. The runner doesn't see this; the stage-resolution step in `run-cto-actor.mjs` reads the policy and registers the matching adapter set.

For the first ship, both adapter sets remain available behind one canon edit. The substrate-deep flag the operator passes (`--mode=substrate-deep`) selects the agentic set when canon authorises it; otherwise it falls back to single-shot with a console warning.

## Components

### `examples/planning-stages/lib/run-stage-agent-loop.ts` (NEW)

Thin orchestration helper. Composes:

- `loadLlmToolPolicy` (existing, `src/llm-tool-policy.ts`)
- `WorkspaceProvider.acquire` (existing, `src/substrate/workspace-provider.ts`)
- Skill-bundle resolver (NEW; small file walker + cache)
- Canon-applicable reader (existing, `host.canon.applicable`)
- `AgentLoopAdapter.run` (existing, `src/substrate/agent-loop.ts`)
- Canon-audit sub-loop dispatcher (NEW; literally another `AgentLoopAdapter.run` with a canon-audit prompt)
- Pipeline-stage-event mint helper (existing + extended)

Surface:
```ts
export interface RunStageAgentLoopInput<TOut> {
  readonly stageInput: StageInput<unknown>;
  readonly stageName: string;
  readonly stagePrincipal: PrincipalId;
  readonly skillBundle: ReadonlyArray<string>;
  readonly promptBuilder: (ctx: PromptBuilderCtx) => string;
  readonly outputSchema: z.ZodSchema<TOut>;
  readonly workspaceMode: 'read-only' | 'read-write';
  readonly maxBudgetUsd: number;
  readonly maxTurns: number;
  readonly maxWallClockMs: number;
  readonly canonAuditPromptBuilder?: (ctx: CanonAuditCtx) => string;
}

export interface RunStageAgentLoopResult<TOut> {
  readonly value: TOut;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly sessionAtomId: AtomId;
  readonly turnAtomIds: ReadonlyArray<AtomId>;
  readonly canonBoundAtomIds: ReadonlyArray<AtomId>;
  readonly canonAuditFindings: ReadonlyArray<AuditFinding>;
}

export async function runStageAgentLoop<TOut>(
  input: RunStageAgentLoopInput<TOut>,
): Promise<RunStageAgentLoopResult<TOut>>;
```

The function honours the runner's threat-model contract: kill-switch poll before any write, claim-before-mutate on session-atom updates, redaction via `input.stageInput.host` adapters.

### `examples/planning-stages/{brainstorm,spec,plan,review}/agentic.ts` (NEW)

Per stage, a sibling adapter file exporting an `agentic<Stage>Stage` value implementing `PlanningStage<TIn, TOut>`. The single-shot reference adapter at `index.ts` is preserved; the agentic adapter opts in via canon policy.

The `agentic.ts` module:
1. Imports the same `<stage>PayloadSchema` zod from the single-shot adapter so output shape is identical.
2. Builds the per-stage prompt scaffold (skill bundle + canon summary + stage-specific instructions).
3. Calls `runStageAgentLoop` with the stage's principal + skill + schema.
4. Re-runs the existing single-shot `audit*` function over the value (citation + path closure checks unchanged).
5. Returns a `StageOutput` with `atom_type: '<stage>-output'` (single-pass + agentic share types).

### `examples/planning-stages/skills/` (NEW; vendored skill bundles)

Vendored copy of the superpowers skill markdown the operator's plugin cache holds, so a deployment that doesn't have the plugin installed can still run the killer pipeline. Files:

- `brainstorming.md` (vendored copy of `superpowers/.../brainstorming/SKILL.md` + companion prompts)
- `writing-plans.md`
- `requesting-code-review.md` adapted as `pipeline-review.md`
- `subagent-driven-development.md` (used by dispatch-stage hand-off prompts)

The vendored copies are normative for pipeline runs; the operator's local plugin is preferred when available so updates flow through. Resolution is a try-resolve-from-plugin-then-vendored helper.

### `examples/planning-stages/agentic-stages.ts` (NEW; adapter registry)

A factory: `buildAgenticStageRegistry(opts)` returns a `Map<string, PlanningStage<...>>` that mirrors the single-shot registry the runner builds today, but composed of the agentic adapters. `run-cto-actor.mjs` reads the canon policy and chooses one registry over the other.

### `src/runtime/planning-pipeline/atom-shapes.ts` (EXTEND)

Extend `TRANSITION` enum with the three new transitions. Update `mkPipelineStageEventAtomInput`'s `transition` type. Add fields to metadata:

- For `canon-bound`: `metadata.canon_atom_ids: string[]`.
- For `canon-audit-complete`: `metadata.findings: AuditFinding[]`, `metadata.verdict: 'approved' | 'issues-found'`.
- For `agent-turn`: `metadata.agent_turn_atom_id: string` (pointer to the existing agent-turn atom written by the adapter).

The new transitions reuse the same shallow shape; no new top-level Atom field. The console deliberation-trail surface filters by `transition` already.

### `apps/console/src/features/deliberation-trail/` (EXTEND)

Render the new transitions:
- `canon-bound`: a row showing "Loaded N canon directives" with expand-to-show-list.
- `canon-audit-complete`: a row showing the verdict + finding count, expandable to the findings list.
- `agent-turn`: a row showing turn index + tools used + cost; clicking opens the agent-turn atom detail viewer (already rendered by `atom-detail-viewer/`).

### Canon atoms (NEW, via bootstrap)

- `pol-planning-pipeline-stage-implementations-default`: subject + per-stage `mode: 'single-shot' | 'agentic'` map. Indie floor stays `'single-shot'`; substrate-deep activates `'agentic'`.
- `pol-pipeline-stage-skill-bundle-default`: subject + per-stage skill name -> resolved path/contents.
- `pol-pipeline-stage-canon-audit-default`: subject + per-stage `audit_enabled: bool` (default true for the four upstream stages).
- `pol-pipeline-stage-budget-default-substrate-deep`: per-stage `max_budget_usd, max_turns, max_wall_clock_ms` -- generous defaults given operator's spare-no-tokens posture.

## Data flow

```text
operator-intent (seed)
  -> pipeline atom (existing)
    -> brainstorm-stage runs:
       1. canon-bound event (lists 60+ L3 directives)
       2. agent-loop dispatched (Claude Code adapter, brainstorm-actor principal)
          - reads canon via Read tool
          - runs grep/glob to survey codebase
          - emits agent-turn atoms throughout
          - produces BrainstormPayload as final tool-output JSON
       3. canon-audit-complete event (verdict: approved)
       4. brainstorm-output atom written (existing path)
       5. pipeline-stage-event exit-success
    -> spec-stage runs (same shape, prior-output threaded)
    -> plan-stage runs (same shape, with TDD bite-sized task scaffold from writing-plans)
    -> review-stage runs (same shape, but reads cited paths/atoms via tools and produces findings)
    -> dispatch-stage runs (unchanged: registry handoff)
  -> autonomous PR opens via the existing dispatch flow
```

Every event is a queryable atom. The console renders the chain.

## Threat model

Inherits the runner's existing threat-model posture:
- Kill-switch absolute priority: poll before every transition + every write. The agent-loop adapter honours `signal` for cooperative cancellation; killswitch-flip translates to `signal.abort()`.
- Tool-policy enforcement: per-principal `disallowedTools` resolved from canon and forwarded to the adapter. The `pipeline-auditor` and `brainstorm-actor` posture (Read+Grep+Glob only) prevents these stages from mutating workspace state. The `cto-actor` plan-stage reuses its existing read-only posture. None of the four upstream stages get write tools.
- Workspace isolation: per-stage workspace acquired via `WorkspaceProvider`. Read-only mode rejects writes at the workspace adapter layer.
- Canon-grounding fence: the skill bundle's HARD-CONSTRAINTS plus the post-output canon-audit step are belt-and-suspenders. A compromised stage prompt cannot bypass the audit because the audit runs as a separate fresh agent-loop with no shared context.
- Budget caps: per-stage `max_budget_usd` from canon (default $5.00 for substrate-deep stages -- spare-no-tokens posture, but bounded). Per-stage `max_turns` (default 25) bounds runaway loops.
- Citation closure fence: the existing `verifiedCitedAtomIds` + `verifiedSubActorPrincipalIds` + `operatorIntentContent` threading is preserved. The agentic adapters consume the same fields.

## Testability

Per task in the plan:
- **Contract test**: each agentic adapter has a unit test asserting the prompt scaffold contains the skill bundle, the canon summary, and the literal operator-intent. Mock the `AgentLoopAdapter` with a stub that returns a known payload; assert the audit hooks run; assert the StageOutput shape.
- **Integration test on MemoryHost**: a single-stage run with a stub agent-loop adapter that emits known agent-turn atoms; assert the pipeline-stage-event chain matches the expected sequence (canon-bound, agent-turn x N, canon-audit-complete, exit-success).
- **End-to-end test**: a full pipeline run on `MemoryHost` with all 5 stages composed of agentic adapters using a deterministic stub adapter; assert chain integrity, schema validity, and atom-store completeness.
- **Real-LLM dogfeed**: a manual run via `node scripts/run-cto-actor.mjs --request "..." --mode=substrate-deep` that exercises the real `ClaudeCodeAgentLoopAdapter`. Compared side-by-side with a single-shot run on the same intent.

## Acceptance criteria

1. A single-stage agentic adapter can be invoked via the existing runner unchanged.
2. The pipeline-stage-event chain for a single agentic-stage run includes: enter, canon-bound, agent-turn (>=1), canon-audit-complete, exit-success.
3. The agentic adapter's StageOutput passes the same zod schema as the single-shot adapter's StageOutput.
4. The console deliberation-trail renders all new transitions.
5. A real-LLM dogfeed run on a non-trivial intent produces output qualitatively superior to the single-shot baseline (operator's "phenomenal" criterion). Concretely: the brainstorm names >=3 alternatives with non-paraphrased trade-offs that cite actual code; the spec body is >=400 words and reads as a design doc; the plan emits >=3 bite-sized tasks each with exact file paths and code snippets; the review-report verifies every cited path/atom by walking it; the dispatch hands off only after the upstream chain is verifiably grounded.
6. The full chain survives kill-switch flip mid-stage: the agent-loop session writes a session atom with `terminal_state: 'aborted'` and the runner returns `{kind: 'halted'}`.
7. The autonomous PR that lands from a substrate-deep run merges with CR APPROVED on the first round (no follow-up CR cycle for citation/grounding errors -- the canon-audit checkpoint catches them).

## Rollout

- Phase 1 (T1-T4): substrate extensions + the helper + the brainstorm-stage agentic adapter.
- Phase 2 (T5-T7): plan + spec + review agentic adapters.
- Phase 3 (T8): console rendering of the new transitions.
- Phase 4 (T9-T10): tests + dogfeed validation.

Default mode stays `single-pass`; the agentic adapters opt in via canon policy after T10. No existing deployment changes behaviour without an explicit canon edit.

## What breaks if revisited

The substrate seam (`PlanningStage` interface) is unchanged, so a future revisit of skill choice, prompt scaffolds, or workspace policy is a per-adapter edit. Replacing the skill bundle wholesale is a vendored-file edit + a canon policy bump. Replacing the agent-loop adapter is the existing `AgentLoopAdapter` swap (Claude Code -> LangGraph -> custom).

What we DO foreclose: the assumption that a stage's output always comes from a single LLM call. The runner already accepts an arbitrary `Promise<StageOutput<T>>` from `stage.run()`, so this assumption was already gone; this design exercises the seam and makes the multi-call shape canonical.

## Alternatives rejected

1. **Add a new substrate type for "agentic stage"**: rejected. The `PlanningStage` interface already accepts arbitrary run() implementations. Adding a new type would split the seam without adding capability.
2. **Run all 5 stages through the same agent-loop session (single conversation, multi-turn)**: rejected. Stages need isolated context for canon-audit independence; a shared-context conversation would let one stage's drift contaminate downstream stages without a fresh-context audit being able to catch it.
3. **Rebuild canon-binding as a runner-side preflight (not per-stage)**: rejected. Each stage's principal is different; canon applicable to `brainstorm-actor` differs from canon applicable to `cto-actor`. Per-stage canon-binding stays under the stage adapter.
4. **Skip the canon-audit step**: rejected. The dogfeeds explicitly motivated the `dev-implementation-canon-audit-loop` directive; skipping it for the upstream stages while keeping it for downstream code-author dispatch would be inconsistent governance.

## Provenance

- `dev-deep-planning-pipeline` (existing canon describing the pluggable substrate; this design implements one of its envisioned upgrade paths).
- `dev-implementation-canon-audit-loop` (canon mandating per-task canon-audit; this design extends to per-stage).
- `dev-substrate-not-prescription` (org-ceiling deployments compose; this design preserves that).
- `dev-pipeline-default-mode` (indie-floor default = single-pass; this design preserves that).
- `inv-governance-before-autonomy` (every gate exists; this design adds two: canon-bound + canon-audit).
- PR1 substrate `feat/agentic-actor-loop` (`AgentLoopAdapter`, agent-session + agent-turn atom types -- this design composes them, no substrate change).
- PR3 real Claude Code adapter (`ClaudeCodeAgentLoopAdapter` -- this design routes pipeline stages through it).

## Operator approval gate

This is an L3-shape change (canon edits + new policy atoms). It surfaces an autonomous PR via the same operator-intent envelope that authorised the original deep-pipeline ship. The substrate-deep mode it activates is opt-in per pipeline run; default-deny posture preserved.
