#!/usr/bin/env node
/**
 * cto-actor driver (Phase 55b + LLM-judgment).
 *
 * Invokes the PlanningActor under the cto-actor Principal against an
 * operator request, producing Plan atoms + HIL escalations.
 *
 * Usage:
 *   # Default: LLM-backed thinking CTO via ClaudeCliLLM (Opus).
 *   node scripts/run-cto-actor.mjs --request "Should we ship the auditor role?"
 *
 *   # Rollback: deterministic stub judgment (no LLM call).
 *   node scripts/run-cto-actor.mjs --request "..." --stub
 *
 *   # Tune models / caps per run:
 *   node scripts/run-cto-actor.mjs --request "..." --classify-model claude-opus-4-7
 *
 * Composition:
 *
 *   Host (createFileHost, llm=ClaudeCliLLM)
 *     -> Principal (cto-actor from host.principals)
 *        -> Actor (PlanningActor)
 *           -> Judgment (HostLlmPlanningJudgment, default; stub opt-in via --stub)
 *              -> runActor driver (checkToolPolicy gate, audit, budget)
 *                 -> atoms.put(planAtom) + notifier.telegraph(escalation)
 */

import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';
import { ClaudeCliLLM } from '../dist/adapters/claude-cli/index.js';
import { runActor } from '../dist/actors/index.js';
import {
  HostLlmPlanningJudgment,
  PlanningActor,
} from '../dist/actors/planning/index.js';
import { loadLlmToolPolicy } from '../dist/llm-tool-policy.js';
import { askQuestion } from '../dist/runtime/questions/index.js';
import { runPlanApprovalTick } from '../dist/actor-message/index.js';
import { parseRunCtoActorArgs } from './lib/run-cto-actor.mjs';
import { computeVerifiedCitedAtomIds } from './lib/verified-citation-set.mjs';

// Instance configuration lives here, NOT in src/. Framework code
// stays mechanism-focused; vendor model ids are the caller's choice.
// Per operator directive 2026-04-19: Opus for both classify and
// draft; plans are the most important thing we build, spare no
// tokens.
const DEFAULT_CLASSIFY_MODEL = 'claude-opus-4-7';
const DEFAULT_DRAFT_MODEL = 'claude-opus-4-7';

// Instance policy for the "thinking" run posture. Per operator
// directive 2026-04-20: "these budgets should be inherently much
// higher, getting things right and sparing no tokens and using
// maximum effort in order to get to the perfect setup is part of
// our canon." The Claude Code CLI we shell out to reports
// `total_cost_usd` as a self-metered effort counter against a
// would-be-API-billing rate; on subscription that number is not a
// real charge, it is the "how hard should the CLI try before
// giving up on one call" knob. 50 USD leaves comfortable headroom
// for rich planning runs that explore multiple tool-use attempts
// before producing structured output.
//
// 30-minute wallclock is similarly generous: complex drafts
// legitimately take 3-8 minutes; the default must never be the
// reason a legitimate run gets killed. Operator override remains
// via --max-budget-usd and --timeout-ms.
const INSTANCE_MAX_BUDGET_USD_PER_CALL = 50.0;
const INSTANCE_JUDGE_TIMEOUT_MS = 1_800_000;

// Each iteration spawns (up to) 2 judge calls: classify + draft.
// Used to size the deadline so we do not budget-deadline a run
// whose LLM calls are legitimately slow.
const JUDGE_CALLS_PER_ITERATION = 2;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');
const STOP_SENTINEL = resolve(STATE_DIR, 'STOP');

function printUsageAndExit() {
  console.log([
    'Usage: node scripts/run-cto-actor.mjs --request "<text>" [options]',
    '',
    'Options:',
    '  --request "<text>"       Required. The operator question.',
    '  --stub                   Use the deterministic stub judgment (no LLM call).',
    '  --classify-model <name>  Override the classify-step model. Default claude-opus-4-7.',
    '  --draft-model <name>     Override the draft-step model. Default claude-opus-4-7.',
    '  --max-budget-usd <n>     Per-call budget cap. Default 50.00 (instance "spare-no-tokens" posture on Claude Code subscription; the CLI treats this as a synthetic effort counter, not a real charge on subscription).',
    '  --timeout-ms <n>         Per-call LLM timeout (ms). Default 1800000 (30 min) for Opus rich drafts.',
    '  --min-confidence <n>     Drop plans below this confidence. Default 0.55.',
    '  --max-iterations <n>     runActor iteration cap. Default 2.',
    '  --principal <id>         Principal to run as. Default cto-actor.',
    '  --origin <id>            runActor origin tag. Default operator.',
    '  --intent-id <id>         Intent atom id that triggered this planning run. When set, appended to the produced plan atom\'s provenance.derived_from so the provenance chain traces back to the triggering intent. Omit when no intent atom exists. Example: --intent-id intent-abc123.',
    '  --delegate-to <id>       Declared target sub-actor principal for any plan produced this run. Stamps metadata.delegation.sub_actor_principal_id on the plan atom for the auto-approve dispatcher to read, gated by its own policy.allowed_sub_actors. Omit to leave the plan unrouted. Example: --delegate-to code-author.',
    '  --mode <single-pass|substrate-deep>  Planning mode. Default single-pass (indie floor). substrate-deep routes through the multi-stage planning pipeline (brainstorm + spec + plan + review + dispatch); requires the bootstrap canon for the pipeline stage policy to be present.',
    "  --invokers <path>        Optional. Path to an .mjs module whose default export is `async (host, registry) => void` and registers sub-actor invokers (e.g. code-author) on the SubActorRegistry the dispatch-stage hands plans to. Mirrors run-approval-cycle.mjs's --invokers seam so the deep-pipeline dispatch-stage and the approval-cycle daemon share one canonical wiring path. Without it the registry ships with auditor-actor only; plans that delegate to code-author or another unregistered sub-actor will fail-loud at dispatch.",
  ].join('\n'));
  process.exit(0);
}

/**
 * Stub PlanningJudgment: returns a deterministic skeleton plan
 * citing the top canon directives. The real LLM-backed judgment
 * lands in a follow-up phase; for 55b this proves the full wire.
 */
function stubJudgment() {
  return {
    async classify(context) {
      const directiveIds = context.directives.slice(0, 8).map((a) => a.id);
      return {
        kind: 'research',
        rationale: 'Stub judgment: real LLM-backed classification ships in the next phase.',
        applicableDirectives: directiveIds,
      };
    },
    async draft(context) {
      const principles = context.directives.slice(0, 5).map((a) => a.id);
      const relevant = context.relevantAtoms.slice(0, 5).map((a) => a.id);
      const citations = [...principles, ...relevant];
      // Provenance directive (canon): every atom must carry a source
      // chain. Never emit an uncited plan. If there is no canon
      // directive and no relevant atom to cite, the right move is to
      // escalate "missing context" to the operator, not fabricate a
      // grounding-less plan atom.
      if (citations.length === 0) {
        return [{
          title: 'Missing context: cannot draft a grounded plan',
          body: [
            `Request: ${context.request}`,
            '',
            'Aggregation returned zero canon directives AND zero',
            'relevant atoms for this request. Drafting a plan without',
            'any citation would violate the provenance directive',
            '(every atom carries a source chain, no exceptions).',
            '',
            'Operator action: either provide a more specific request',
            'that hits current canon, seed canon directives relevant',
            'to this domain, or broaden aggregate-context caps.',
          ].join('\n'),
          derivedFrom: [],
          principlesApplied: [],
          alternativesRejected: [],
          whatBreaksIfRevisit: 'N/A: this plan exists only to surface the missing-context state to the operator.',
          confidence: 0.2,
        }];
      }
      return [{
        title: 'Research and surface options (stub)',
        body: [
          `Request: ${context.request}`,
          '',
          'This is a stub plan produced by the 55b driver before the',
          'LLM-backed PlanningJudgment ships. It references the canon',
          'directives and the top relevant atoms so the HIL escalation',
          'is still grounded; a real plan will enumerate concrete',
          'steps and alternatives.',
        ].join('\n'),
        derivedFrom: citations,
        principlesApplied: principles,
        alternativesRejected: [
          { option: 'Wait (do nothing)', reason: 'Leaves the operator without a surfaced decision path.' },
        ],
        whatBreaksIfRevisit: 'Low. Stub plans are superseded when the LLM judgment lands.',
        confidence: 0.5,
      }];
    },
  };
}

/**
 * Substrate-deep planning entry-point.
 *
 * Composes the planning-pipeline runner with the canon-resolved stage
 * descriptors. The driver reads pol-planning-pipeline-stages-default
 * to discover stage names + per-stage principals, then walks them
 * sequentially via runPipeline. State is fully atom-projected per
 * the planning-pipeline spec section 11.
 *
 * Pre-flight halts on:
 *   - missing pol-planning-pipeline-stages-default (Task 13 bootstrap
 *     not yet applied);
 *   - missing --intent-id when the substrate requires an authorizing
 *     operator-intent for the deep mode (per spec section 14.5);
 *   - empty stage list (malformed canon).
 *
 * Stage-actor composition (the concrete brainstorm/spec/plan/review/
 * dispatch adapter set under examples/planning-stages/) wires through
 * a follow-up invoker registry; this driver halts loud rather than
 * silently degrading.
 */
async function runDeepPipeline(args) {
  // dist/runtime/planning-pipeline must be present; guarded so a
  // dev who runs the script before npm run build sees a clear
  // diagnostic instead of a module-not-found stacktrace.
  let runPipeline;
  let readPipelineStagesPolicy;
  try {
    const mod = await import('../dist/runtime/planning-pipeline/index.js');
    ({ runPipeline, readPipelineStagesPolicy } = mod);
  } catch (err) {
    console.error(
      'ERROR: --mode substrate-deep requires the planning-pipeline build. ' +
      `Run "npm run build" first. Underlying error: ${err?.message ?? err}`,
    );
    process.exit(2);
  }
  if (!args.intentId) {
    console.error(
      'ERROR: --mode substrate-deep requires an authorizing --intent-id. ' +
      'A deep-pipeline run is gated on a fresh operator-intent atom whose ' +
      'trust envelope authorizes the multi-stage cost. Re-run with ' +
      '--intent-id <operator-intent-atom-id>.',
    );
    process.exit(2);
  }

  // Wire an LLM into the deep-mode host because the reference brainstorm,
  // spec, plan, and review adapters call host.llm.judge. Without this,
  // the first stage that reaches host.llm.judge fails at runtime. Use
  // ClaudeCliLLM (the same default the single-pass path uses) with the
  // operator-tunable per-call timeout. Per-call budget cap is forwarded
  // by the runner via stage.budget_cap_usd / pol-pipeline-stage-cost-cap.
  const llm = new ClaudeCliLLM({
    defaultTimeoutMs: args.timeoutMs ?? INSTANCE_JUDGE_TIMEOUT_MS,
  });
  const host = await createFileHost({ rootDir: STATE_DIR, llm });
  const principal = await host.principals.get(args.principalId);
  if (!principal) {
    console.error(
      `ERROR: principal '${args.principalId}' not found. Run scripts/bootstrap-cto-actor-canon.mjs first.`,
    );
    process.exit(1);
  }

  // Validate the supplied intent atom is the right type and carries a
  // fresh trust envelope before consuming pipeline budget. Failing
  // closed here keeps a stale or malformed intent from authorising a
  // multi-stage run; the autonomous-intent canon surface is the
  // load-bearing approval gate, not the intent-id flag itself.
  const intentAtom = await host.atoms.get(args.intentId);
  if (intentAtom === null) {
    console.error(
      `ERROR: --intent-id '${args.intentId}' does not resolve via host.atoms.get.`,
    );
    process.exit(2);
  }
  if (intentAtom.type !== 'operator-intent') {
    console.error(
      `ERROR: --intent-id '${args.intentId}' resolves to atom type `
      + `'${intentAtom.type}', not 'operator-intent'. The substrate-deep `
      + 'gate requires an operator-authored intent atom.',
    );
    process.exit(2);
  }
  if (intentAtom.taint !== 'clean') {
    console.error(
      `ERROR: --intent-id '${args.intentId}' is tainted ('${intentAtom.taint}') `
      + 'and cannot authorise a substrate-deep run.',
    );
    process.exit(2);
  }
  if (intentAtom.expires_at !== null && intentAtom.expires_at !== undefined) {
    const expiry = new Date(intentAtom.expires_at).getTime();
    if (Number.isFinite(expiry) && expiry < Date.now()) {
      console.error(
        `ERROR: --intent-id '${args.intentId}' expired at `
        + `${intentAtom.expires_at}; the trust envelope is no longer fresh.`,
      );
      process.exit(2);
    }
  }
  const trustEnvelope = intentAtom.metadata?.trust_envelope;
  if (trustEnvelope === undefined || trustEnvelope === null
      || typeof trustEnvelope !== 'object') {
    console.error(
      `ERROR: --intent-id '${args.intentId}' is missing a trust_envelope `
      + 'on metadata; substrate-deep requires an operator-signed envelope.',
    );
    process.exit(2);
  }

  const stages = await readPipelineStagesPolicy(host, { scope: 'project' });
  if (stages.atomId === null || stages.stages.length === 0) {
    console.error(
      'ERROR: pol-planning-pipeline-stages-default is missing or empty. ' +
      'Run scripts/bootstrap-deep-planning-pipeline-canon.mjs to seed the ' +
      'pipeline canon, then retry --mode substrate-deep.',
    );
    process.exit(2);
  }

  // Resolve stage adapters from the reference set shipped in
  // examples/planning-stages/. Each canon-listed stage name must map
  // to an adapter; an unmapped stage halts the driver rather than
  // silently truncating the pipeline. Custom org stages drop in by
  // adding entries to this map (the registry-wiring follow-up may
  // replace this in-script literal with a per-stage canon-driven
  // resolver, which is mechanism, not policy).
  const { brainstormStage } = await import('../dist/examples/planning-stages/brainstorm/index.js');
  const { specStage } = await import('../dist/examples/planning-stages/spec/index.js');
  const { planStage } = await import('../dist/examples/planning-stages/plan/index.js');
  const { reviewStage } = await import('../dist/examples/planning-stages/review/index.js');
  const { createDispatchStage } = await import('../dist/examples/planning-stages/dispatch/index.js');
  const { SubActorRegistry, runAuditor } = await import('../dist/runtime/actor-message/index.js');

  // Wire the SubActorRegistry the dispatch-stage hands plans to.
  // V0 ships the auditor invoker (read-only, always safe to invoke);
  // additional invokers (code-author, future actors) are registered
  // via the same `--invokers` seam run-approval-cycle.mjs uses, so
  // the deep-pipeline dispatch-stage and the approval-cycle daemon
  // share one canonical wiring path. Without this, the dispatch
  // stage would invoke into an empty registry and every plan that
  // delegates to code-author would fail with "principal X is not
  // registered" -- the exact failure observed on dogfeed-6
  // (pipeline-cto-1777608728292-k5u0yc, 2026-04-30) where dispatch
  // claimed an approved plan and then errored at registry.invoke.
  const subActorRegistry = new SubActorRegistry();
  subActorRegistry.register(
    'auditor-actor',
    async (payload, corr) => runAuditor(host, payload, corr),
  );
  if (args.invokersPath !== null) {
    const modPath = resolve(args.invokersPath);
    if (!existsSync(modPath)) {
      console.error(`ERROR: --invokers ${modPath} does not exist.`);
      process.exit(2);
    }
    // Cross-platform-safe: pathToFileURL() handles Windows drive
    // letters AND POSIX absolute paths uniformly. The manual
    // `new URL('file:///' + path)` shape that ships in
    // run-approval-cycle.mjs leaks the leading `/` on POSIX (an
    // absolute path /a/b becomes file:////a/b) and is the kind of
    // platform drift this seam should not carry; pathToFileURL is
    // the official Node helper for exactly this conversion.
    const mod = await import(pathToFileURL(modPath).href);
    if (typeof mod.default !== 'function') {
      console.error(
        'ERROR: --invokers module must default-export '
        + `\`async (host, registry) => void\` (got ${typeof mod.default}).`,
      );
      process.exit(2);
    }
    await mod.default(host, subActorRegistry);
    console.log(
      `[cto-actor] sub-actor registry populated via ${args.invokersPath}; `
      + `registered=[${subActorRegistry.list().join(', ')}]`,
    );
  } else {
    console.log(
      '[cto-actor] sub-actor registry populated with auditor-actor only; '
      + 'pass --invokers <path> to register code-author or other sub-actors.',
    );
  }
  const stageRegistry = new Map([
    ['brainstorm-stage', brainstormStage],
    ['spec-stage', specStage],
    ['plan-stage', planStage],
    ['review-stage', reviewStage],
    ['dispatch-stage', createDispatchStage(subActorRegistry)],
  ]);
  const stageAdapters = [];
  const unresolvedStages = [];
  for (const s of stages.stages) {
    const adapter = stageRegistry.get(s.name);
    if (adapter === undefined) {
      unresolvedStages.push(s.name);
    } else {
      stageAdapters.push(adapter);
    }
  }
  if (unresolvedStages.length > 0) {
    console.error(
      `ERROR: no stage adapters resolved for stages [${unresolvedStages.join(', ')}]. ` +
      'Each canon-listed stage requires a registered adapter. Add the ' +
      'adapter to the in-script stageRegistry map in run-cto-actor.mjs ' +
      'or override the stages list via the canon policy.',
    );
    process.exit(2);
  }

  const correlationId = `cto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Compute the verified citation set the runner forwards into every
  // stage's StageInput. The set is the closure of citations the
  // pipeline's LLM-driven stages may ground on: the seed atoms (the
  // operator-intent that authorised the run) PLUS the canon atoms
  // applicable at the planning principal's scope. Without this set,
  // the LLM has no positive signal for "what counts as a real atom-
  // id", which is how the dogfeed of 2026-04-30 produced four
  // fabricated principle ids in the plan-stage. Computed once per
  // pipeline run; the runner threads the readonly array through the
  // existing StageInput shape and never mutates it.
  const verifiedCitedAtomIds = await computeVerifiedCitedAtomIds(host, {
    seedAtomIds: [args.intentId],
    scope: 'project',
  });
  console.log(
    `[cto-actor] verified-citation-set computed for principal=${principal.id} `
    + `scope=project: ${verifiedCitedAtomIds.length} atom-ids `
    + `(${[args.intentId].length} seed + `
    + `${verifiedCitedAtomIds.length - [args.intentId].length} canon)`,
  );
  // Compute the verified sub-actor principal-id set. The intent
  // envelope's allowed_sub_actors IS the per-run authoritative list
  // of executable sub-actors -- the same set the auto-approve flow
  // checks against -- so reading it here keeps the plan-stage
  // delegation fence in lock-step with the auto-approve gate.
  // Filter to string entries defensively; the envelope schema is
  // operator-authored and may carry malformed values that the
  // runner's freeze cannot retroactively repair. A non-array or
  // empty allowed_sub_actors leaves the set empty; the plan-stage
  // prompt then forbids any delegation, which is the correct
  // behaviour because no sub-actor is authorised for this intent.
  const allowedSubActorsRaw = trustEnvelope.allowed_sub_actors;
  const verifiedSubActorPrincipalIds = Array.isArray(allowedSubActorsRaw)
    ? allowedSubActorsRaw.filter((v) => typeof v === 'string')
    : [];
  console.log(
    `[cto-actor] verified-sub-actor-principal-id-set computed from `
    + `intent.metadata.trust_envelope.allowed_sub_actors: `
    + `${verifiedSubActorPrincipalIds.length} principal-id(s)`,
  );
  // Read the literal operator-intent.content the runner threads into
  // every stage as a semantic-faithfulness anchor. The intentAtom is
  // already loaded above for envelope verification, so this is a
  // free read. Defensive coercion: intent.content is typed as string
  // on the substrate, but a malformed atom-on-disk could carry a
  // non-string here, in which case the empty-default falls through
  // and the stage prompts treat the missing anchor as "fall back to
  // prior-stage output" rather than fail-closed.
  const operatorIntentContent =
    typeof intentAtom.content === 'string' ? intentAtom.content : '';
  console.log(
    `[cto-actor] operator-intent.content threaded into pipeline as `
    + `semantic-faithfulness anchor: ${operatorIntentContent.length} chars`,
  );
  const result = await runPipeline(stageAdapters, host, {
    principal: principal.id,
    correlationId,
    seedAtomIds: [args.intentId],
    stagePolicyAtomId: stages.atomId,
    mode: 'substrate-deep',
    verifiedCitedAtomIds,
    verifiedSubActorPrincipalIds,
    operatorIntentContent,
  });
  console.log('[cto-actor] --- DEEP-PIPELINE REPORT ---');
  console.log(JSON.stringify(result, null, 2));
  if (result.kind === 'completed') process.exit(0);
  if (result.kind === 'hil-paused') process.exit(0);
  process.exit(1);
}

async function main() {
  const parsed = parseRunCtoActorArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`ERROR: ${parsed.reason}`);
    process.exit(2);
  }
  const args = parsed.args;
  if (args.help) printUsageAndExit();

  // --dry-run is not yet wired: atom writes + notifier calls still
  // happen through the Host. A "dry-run" that silently mutated the
  // atom store is a user-visible correctness bug, so we reject the
  // flag up-front until proper no-op Host decorators ship (paired
  // with the LLM-judgment phase where cost/side-effect simulation
  // actually matters).
  if (args.dryRun) {
    console.error(
      'ERROR: --dry-run is not yet implemented. It would require a no-op ' +
      'Host decorator that skips atoms.put + notifier.telegraph; that ' +
      'ships alongside the LLM-judgment phase. Rerun without --dry-run ' +
      'to execute a live run under the cto-actor policy atoms.',
    );
    process.exit(2);
  }

  // Mode-gated branch. --mode substrate-deep routes through the
  // multi-stage planning pipeline (brainstorm + spec + plan + review
  // + dispatch). The default single-pass mode keeps the existing
  // PlanningActor path unchanged; tactical clarifications and
  // small-scope plans amortize their cost there.
  //
  // The substrate-deep path requires the bootstrap canon to seed
  // the pipeline stage policy (pol-planning-pipeline-stages-default)
  // and the per-stage HIL policies. When the canon is not yet
  // present, the runner halts at pre-flight with a malformed-stages
  // failure rather than degrading silently.
  if (args.mode === 'substrate-deep') {
    await runDeepPipeline(args);
    return;
  }

  // LLM adapter: ClaudeCliLLM uses the user's existing Claude Code
  // OAuth (no API key). Only built if we're not running in --stub
  // mode, so the stub path has zero adapter cost.
  const llm = args.stub ? undefined : new ClaudeCliLLM({});
  const host = await createFileHost({ rootDir: STATE_DIR, llm });

  const principal = await host.principals.get(args.principalId);
  if (!principal) {
    console.error(
      `ERROR: principal '${args.principalId}' not found. Run scripts/bootstrap-cto-actor-canon.mjs first.`,
    );
    process.exit(1);
  }

  // Read the per-principal LLM tool policy from canon (if present).
  // `null` means "no policy atom for this principal yet"; the
  // HostLlmPlanningJudgment + ClaudeCliLLM chain will fall back to
  // the adapter's safety default (deny-all). Policy atoms land via
  // canon bootstrap scripts; this runner is the consumer, not the
  // seeder.
  const toolPolicy = await loadLlmToolPolicy(host.atoms, principal.id);
  if (toolPolicy) {
    console.log(
      `[cto-actor] llm-tool-policy loaded for ${principal.id}: `
      + `disallowed=[${toolPolicy.disallowedTools.join(', ')}]`,
    );
  } else {
    console.log(
      `[cto-actor] no llm-tool-policy atom for ${principal.id}; using adapter default (deny-all).`,
    );
  }

  // Default: LLM-backed thinking CTO. --stub routes through the old
  // deterministic judgment as an explicit rollback path (useful for
  // diagnosing whether a regression is in the actor or in the LLM).
  const judgment = args.stub
    ? stubJudgment()
    : new HostLlmPlanningJudgment(host, {
        classifyModel: args.classifyModel ?? DEFAULT_CLASSIFY_MODEL,
        draftModel: args.draftModel ?? DEFAULT_DRAFT_MODEL,
        // Instance policy: spare-no-tokens posture on Claude Code
        // subscription. Framework defaults in src/ are conservative;
        // the "thinking" run posture is expressed here where it belongs.
        maxBudgetUsdPerCall: args.maxBudgetUsdPerCall ?? INSTANCE_MAX_BUDGET_USD_PER_CALL,
        timeoutMs: args.timeoutMs ?? INSTANCE_JUDGE_TIMEOUT_MS,
        ...(args.minConfidence !== undefined ? { minConfidence: args.minConfidence } : {}),
        ...(toolPolicy ? { disallowedTools: toolPolicy.disallowedTools } : {}),
      });

  // Seed a Question atom for this request BEFORE running the
  // planning actor. Two load-bearing reasons:
  //
  // 1. Provenance: the autonomous path is `Question -> CTO -> Plan ->
  //    CodeAuthor -> PR`. Skipping Question atom creation breaks the
  //    provenance chain the canon assumes and leaves the planning run
  //    without a stable atom id to cite downstream.
  // 2. Drafter literal: the CodeAuthor drafter reads the Plan atom's
  //    metadata.question_prompt as ground-truth payload for the diff.
  //    Without this, a Decision whose prose paraphrases the operator
  //    request reduces "replace the specified line" to an abstract
  //    reference and the drafter emits an empty diff. Propagating the
  //    originating Question's id + body via PlanningActorOptions.
  //    originatingQuestion means the Plan metadata carries the
  //    literal payload through to the drafter. Observed and documented
  //    in docs/dogfooding/2026-04-23-virtual-org-phase-3-git-as-push-auth.md.
  const questionAtom = await askQuestion(host, {
    content: args.request,
    asker: principal.id,
    metadata: {
      asked_via: 'run-cto-actor',
    },
  });
  console.log(`[cto-actor] seeded question atom ${questionAtom.id}`);

  const actor = new PlanningActor({
    request: args.request,
    judgment,
    /*
     * Self-context pre-pass: thread this principal's recent plans /
     * decisions / observations into the planning context. The
     * aggregator filters atoms.principal_id, sorts created_at desc,
     * caps at maxSelfContext (default 30). The judgment template
     * surfaces them as `self_context` so the LLM sees "your prior
     * work" alongside canon and relevant atoms.
     *
     * This is the indie-floor seam for "principals remember
     * themselves across time" -- atoms-as-memory, no agent-loop
     * session resume required. The deeper session-resume path is
     * sequenced separately on the org-ceiling roadmap.
     */
    aggregate: { selfPrincipalId: principal.id },
    originatingQuestion: {
      id: questionAtom.id,
      prompt: args.request,
    },
    // Optional: when --intent-id is provided, append the intent atom
    // id to the produced plan atom's provenance.derived_from so the
    // full lineage (intent -> plan) is traceable in the atom store.
    // Default null means no id is appended and the atom shape is
    // byte-identical to a run without this flag.
    intentId: args.intentId ?? null,
    // Optional: when --delegate-to is provided, stamp the target
    // sub-actor principal id onto the plan atom so the auto-approve
    // dispatcher (src/runtime/actor-message/auto-approve.ts) can
    // route an approved plan to the registered invoker. The gate
    // still lives on the auto-approve policy's allowed_sub_actors;
    // this just carries declared intent from operator to plan atom.
    ...(args.delegateTo ? { delegateTo: args.delegateTo } : {}),
  });

  // Size the deadline so we never budget-deadline a run whose LLM
  // calls are running at the per-call timeout. Worst case per run is
  // maxIterations * JUDGE_CALLS_PER_ITERATION * effective-per-call-timeout,
  // plus slack for actor overhead + atom writes + notifier posts.
  const effectivePerCallTimeoutMs = args.timeoutMs ?? INSTANCE_JUDGE_TIMEOUT_MS;
  const SLACK_MS = 60_000;
  const llmBudgetMs =
    args.maxIterations * JUDGE_CALLS_PER_ITERATION * effectivePerCallTimeoutMs + SLACK_MS;
  const deadlineMs = args.stub ? 60_000 : Math.max(600_000, llmBudgetMs);
  const deadline = new Date(Date.now() + deadlineMs).toISOString();
  const mode = args.stub ? 'STUB' : 'LLM (thinking)';
  console.log(`[cto-actor] ${mode} run as ${args.principalId}`);
  console.log(`[cto-actor] request: ${args.request}`);
  console.log(`[cto-actor] budget: maxIterations=${args.maxIterations}, deadline=${deadline}`);

  const report = await runActor(actor, {
    host,
    principal,
    adapters: {},
    budget: { maxIterations: args.maxIterations, deadline },
    origin: args.origin,
    killSwitch: () => existsSync(STOP_SENTINEL),
    onAudit: async (event) => {
      console.log(`[audit] iter=${event.iteration} kind=${event.kind}`);
      await host.auditor.log({
        kind: `actor.${event.kind}`,
        principal_id: event.principal,
        timestamp: event.at,
        refs: {},
        details: {
          actor: event.actor,
          iteration: event.iteration,
          ...event.payload,
        },
      });
    },
  });

  console.log('[cto-actor] --- REPORT ---');
  console.log(JSON.stringify({
    actor: report.actor,
    principal: report.principal,
    haltReason: report.haltReason,
    iterations: report.iterations,
    startedAt: report.startedAt,
    endedAt: report.endedAt,
    escalations: report.escalations,
    lastNote: report.lastNote,
  }, null, 2));

  // End-of-run opportunistic approval sweep. If votes were cast
  // before this run (HIL reviewers casting lag-respond [v] on a
  // previously-proposed plan), the new plan we just wrote might
  // share a topic whose consensus is already ready, OR a co-scheduled
  // plan in 'proposed' might now clear the threshold. Running the
  // approval tick here catches those immediately instead of waiting
  // for the next approval-cycle daemon pass.
  //
  // Best-effort: a tick failure here MUST NOT alter the CTO run's
  // exit code. The planning work is the load-bearing outcome; a
  // consensus-sweep failure is an operational signal for the approval
  // daemon to surface on its own.
  try {
    const approvalResult = await runPlanApprovalTick(host);
    console.log(
      '[cto-actor] end-of-run plan-approval tick: '
      + `scanned=${approvalResult.scanned} eligible=${approvalResult.eligible} `
      + `approved=${approvalResult.approved} rejected=${approvalResult.rejected} stale=${approvalResult.stale}`,
    );
  } catch (err) {
    console.warn(`[cto-actor] end-of-run plan-approval tick FAILED (non-fatal): ${err?.message ?? err}`);
  }

  if (report.haltReason === 'converged') process.exit(0);
  if (report.haltReason === 'budget-iterations' || report.haltReason === 'budget-deadline') process.exit(2);
  process.exit(1);
}

main().catch((err) => {
  console.error('[cto-actor] FAILED:', err);
  process.exit(1);
});
