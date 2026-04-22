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
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';
import { ClaudeCliLLM } from '../dist/adapters/llm/claude-cli/index.js';
import { runActor } from '../dist/runtime/actors/index.js';
import {
  HostLlmPlanningJudgment,
  PlanningActor,
} from '../dist/runtime/actors/planning/index.js';
import { loadLlmToolPolicy } from '../dist/substrate/policy/tool-policy.js';

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

function parseArgs(argv) {
  const args = {
    request: null,
    dryRun: false,
    maxIterations: 2,
    principalId: 'cto-actor',
    origin: 'operator',
    stub: false,
    classifyModel: undefined,
    draftModel: undefined,
    maxBudgetUsdPerCall: undefined,
    timeoutMs: undefined,
    minConfidence: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--request' && i + 1 < argv.length) args.request = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--stub') args.stub = true;
    else if (a === '--classify-model' && i + 1 < argv.length) args.classifyModel = argv[++i];
    else if (a === '--draft-model' && i + 1 < argv.length) args.draftModel = argv[++i];
    else if (a === '--max-budget-usd' && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) {
        console.error('ERROR: --max-budget-usd expects a positive number');
        process.exit(2);
      }
      args.maxBudgetUsdPerCall = n;
    } else if (a === '--timeout-ms' && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) {
        console.error('ERROR: --timeout-ms expects a positive number');
        process.exit(2);
      }
      args.timeoutMs = n;
    } else if (a === '--min-confidence' && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        console.error('ERROR: --min-confidence expects a number in [0,1]');
        process.exit(2);
      }
      args.minConfidence = n;
    } else if (a === '--max-iterations' && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) {
        console.error('ERROR: --max-iterations expects a positive integer');
        process.exit(2);
      }
      args.maxIterations = n;
    } else if (a === '--principal' && i + 1 < argv.length) args.principalId = argv[++i];
    else if (a === '--origin' && i + 1 < argv.length) args.origin = argv[++i];
    else if (a === '-h' || a === '--help') {
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
      ].join('\n'));
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (args.request === null) {
    console.error('ERROR: --request "<text>" is required.');
    process.exit(2);
  }
  return args;
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

async function main() {
  const args = parseArgs(process.argv.slice(2));

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

  const actor = new PlanningActor({
    request: args.request,
    judgment,
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

  if (report.haltReason === 'converged') process.exit(0);
  if (report.haltReason === 'budget-iterations' || report.haltReason === 'budget-deadline') process.exit(2);
  process.exit(1);
}

main().catch((err) => {
  console.error('[cto-actor] FAILED:', err);
  process.exit(1);
});
