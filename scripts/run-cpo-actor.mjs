#!/usr/bin/env node
/**
 * cpo-actor driver (CPO peer to cto-actor, LLM-judgment).
 *
 * Invokes the PlanningActor under the cpo-actor Principal against an
 * operator request, producing Plan atoms + HIL escalations. The CPO
 * weighs product/user fit, operator experience, narrative +
 * onboarding feel, demo readiness, and surface-simplicity tradeoffs
 * -- the lens the CTO does not carry. Per dev-canon-is-strategic-not-
 * tactical the per-actor posture (judgment-prompt shape, tool scope,
 * blast-radius fences) lives in canon as policy atoms; this driver
 * is mechanism-identical to scripts/run-cto-actor.mjs with the
 * principal id and log labels swapped.
 *
 * Conflicts between CTO and CPO plans on the same topic are
 * arbitrated by the operator via /decide; both actors are L1 at
 * equal source-rank depth and source-rank ties by construction.
 *
 * Usage:
 *   node scripts/run-cpo-actor.mjs --request "Does this onboarding read well?"
 *   node scripts/run-cpo-actor.mjs --request "..." --stub
 *   node scripts/run-cpo-actor.mjs --request "..." --classify-model claude-opus-4-7
 */

import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

const DEFAULT_CLASSIFY_MODEL = 'claude-opus-4-7';
const DEFAULT_DRAFT_MODEL = 'claude-opus-4-7';

const INSTANCE_MAX_BUDGET_USD_PER_CALL = 50.0;
const INSTANCE_JUDGE_TIMEOUT_MS = 1_800_000;
const JUDGE_CALLS_PER_ITERATION = 2;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');
const STOP_SENTINEL = resolve(STATE_DIR, 'STOP');

function parseArgs(argv) {
  const args = {
    request: null,
    dryRun: false,
    maxIterations: 2,
    principalId: 'cpo-actor',
    origin: 'operator',
    stub: false,
    classifyModel: undefined,
    draftModel: undefined,
    maxBudgetUsdPerCall: undefined,
    timeoutMs: undefined,
    minConfidence: undefined,
    delegateTo: undefined,
    intentId: null,
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
    else if (a === '--intent-id' && i + 1 < argv.length) args.intentId = argv[++i];
    else if (a === '--delegate-to' && i + 1 < argv.length) {
      const v = argv[++i];
      if (typeof v !== 'string' || v.trim().length === 0) {
        console.error('ERROR: --delegate-to expects a non-empty principal id');
        process.exit(2);
      }
      args.delegateTo = v;
    }
    else if (a === '-h' || a === '--help') {
      console.log([
        'Usage: node scripts/run-cpo-actor.mjs --request "<text>" [options]',
        '',
        'Options:',
        '  --request "<text>"       Required. The operator question.',
        '  --stub                   Use the deterministic stub judgment (no LLM call).',
        '  --classify-model <name>  Override the classify-step model. Default claude-opus-4-7.',
        '  --draft-model <name>     Override the draft-step model. Default claude-opus-4-7.',
        '  --max-budget-usd <n>     Per-call budget cap. Default 50.00.',
        '  --timeout-ms <n>         Per-call LLM timeout (ms). Default 1800000 (30 min).',
        '  --min-confidence <n>     Drop plans below this confidence. Default 0.55.',
        '  --max-iterations <n>     runActor iteration cap. Default 2.',
        '  --principal <id>         Principal to run as. Default cpo-actor.',
        '  --origin <id>            runActor origin tag. Default operator.',
        '  --intent-id <id>         Intent atom id that triggered this planning run.',
        '  --delegate-to <id>       Declared target sub-actor principal id for the produced plan.',
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

function stubJudgment() {
  return {
    async classify(context) {
      const directiveIds = context.directives.slice(0, 8).map((a) => a.id);
      /*
       * Stub mode picks the 'research' classification for parity with
       * the CTO mirror (scripts/run-cto-actor.mjs:181). The CPO lens
       * (surface-complexity, onboarding-feel, demo-readiness,
       * narrative-coherence per the cpo-actor soul) lives in the
       * rationale, not the kind: kind must be a member of the
       * PlanningClassificationKind union (greenfield, modification,
       * reversal, research, emergency, ambiguous) defined in
       * src/runtime/actors/planning/types.ts. A future LLM-judgment
       * phase may add a CPO-specific kind to that union, but until
       * then 'surface-complexity' is not a valid value and would fail
       * downstream validation when a stub plan is serialized.
       */
      return {
        kind: 'research',
        rationale: 'Stub CPO judgment: real LLM-backed classification ships next phase. Default biases the CPO lens (surface-complexity, onboarding-feel, demo-readiness, narrative-coherence) per the cpo-actor soul; classification kind is research for parity with the CTO mirror.',
        applicableDirectives: directiveIds,
      };
    },
    async draft(context) {
      const principles = context.directives.slice(0, 5).map((a) => a.id);
      const relevant = context.relevantAtoms.slice(0, 5).map((a) => a.id);
      const citations = [...principles, ...relevant];
      if (citations.length === 0) {
        return [{
          title: 'Missing context: cannot draft a grounded CPO plan',
          body: [
            `Request: ${context.request}`,
            '',
            'Aggregation returned zero canon directives AND zero',
            'relevant atoms for this request. Drafting a plan without',
            'any citation would violate the provenance directive.',
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
        title: 'Surface product/operator-experience options (stub)',
        body: [
          `Request: ${context.request}`,
          '',
          'Stub CPO plan produced before the LLM-backed PlanningJudgment',
          'with the CPO judgment-prompt path lands. The CPO lens weighs',
          'product/user fit, operator experience, narrative + onboarding',
          'feel, demo readiness, and surface simplicity. A real plan will',
          'enumerate concrete steps and alternatives through that lens.',
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

  if (args.dryRun) {
    console.error(
      'ERROR: --dry-run is not yet implemented. It would require a no-op ' +
      'Host decorator that skips atoms.put + notifier.telegraph; that ' +
      'ships alongside the LLM-judgment phase. Rerun without --dry-run ' +
      'to execute a live run under the cpo-actor policy atoms.',
    );
    process.exit(2);
  }

  const llm = args.stub ? undefined : new ClaudeCliLLM({});
  const host = await createFileHost({ rootDir: STATE_DIR, llm });

  const principal = await host.principals.get(args.principalId);
  if (!principal) {
    console.error(
      `ERROR: principal '${args.principalId}' not found. Run scripts/bootstrap-cpo-actor-canon.mjs first.`,
    );
    process.exit(1);
  }

  /*
   * Derive log tag + asked_via from the resolved principal so the
   * --principal override is not a footgun. If an operator passes
   * --principal something-else, logs and the question atom's
   * asked_via metadata reflect the actual identity instead of lying
   * about it. Provenance is the substrate's whole point; mislabelled
   * audit lines are exactly what we cannot ship.
   */
  const logTag = `[${principal.id}]`;

  const toolPolicy = await loadLlmToolPolicy(host.atoms, principal.id);
  if (toolPolicy) {
    console.log(
      `${logTag} llm-tool-policy loaded for ${principal.id}: `
      + `disallowed=[${toolPolicy.disallowedTools.join(', ')}]`,
    );
  } else {
    console.log(
      `${logTag} no llm-tool-policy atom for ${principal.id}; using adapter default (deny-all).`,
    );
  }

  const judgment = args.stub
    ? stubJudgment()
    : new HostLlmPlanningJudgment(host, {
        classifyModel: args.classifyModel ?? DEFAULT_CLASSIFY_MODEL,
        draftModel: args.draftModel ?? DEFAULT_DRAFT_MODEL,
        maxBudgetUsdPerCall: args.maxBudgetUsdPerCall ?? INSTANCE_MAX_BUDGET_USD_PER_CALL,
        timeoutMs: args.timeoutMs ?? INSTANCE_JUDGE_TIMEOUT_MS,
        ...(args.minConfidence !== undefined ? { minConfidence: args.minConfidence } : {}),
        ...(toolPolicy ? { disallowedTools: toolPolicy.disallowedTools } : {}),
      });

  const questionAtom = await askQuestion(host, {
    content: args.request,
    asker: principal.id,
    metadata: {
      asked_via: `run-${principal.id}`,
    },
  });
  console.log(`${logTag} seeded question atom ${questionAtom.id}`);

  const actor = new PlanningActor({
    request: args.request,
    judgment,
    originatingQuestion: {
      id: questionAtom.id,
      prompt: args.request,
    },
    intentId: args.intentId ?? null,
    ...(args.delegateTo ? { delegateTo: args.delegateTo } : {}),
  });

  const effectivePerCallTimeoutMs = args.timeoutMs ?? INSTANCE_JUDGE_TIMEOUT_MS;
  const SLACK_MS = 60_000;
  const llmBudgetMs =
    args.maxIterations * JUDGE_CALLS_PER_ITERATION * effectivePerCallTimeoutMs + SLACK_MS;
  const deadlineMs = args.stub ? 60_000 : Math.max(600_000, llmBudgetMs);
  const deadline = new Date(Date.now() + deadlineMs).toISOString();
  const mode = args.stub ? 'STUB' : 'LLM (thinking)';
  console.log(`${logTag} ${mode} run as ${args.principalId}`);
  console.log(`${logTag} request: ${args.request}`);
  console.log(`${logTag} budget: maxIterations=${args.maxIterations}, deadline=${deadline}`);

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

  console.log(`${logTag} --- REPORT ---`);
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

  try {
    const approvalResult = await runPlanApprovalTick(host);
    console.log(
      `${logTag} end-of-run plan-approval tick: `
      + `scanned=${approvalResult.scanned} eligible=${approvalResult.eligible} `
      + `approved=${approvalResult.approved} rejected=${approvalResult.rejected} stale=${approvalResult.stale}`,
    );
  } catch (err) {
    console.warn(`${logTag} end-of-run plan-approval tick FAILED (non-fatal): ${err?.message ?? err}`);
  }

  if (report.haltReason === 'converged') process.exit(0);
  if (report.haltReason === 'budget-iterations' || report.haltReason === 'budget-deadline') process.exit(2);
  process.exit(1);
}

main().catch((err) => {
  console.error('[cpo-actor] FAILED:', err);
  process.exit(1);
});
