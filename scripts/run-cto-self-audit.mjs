#!/usr/bin/env node
/**
 * run-cto-self-audit: exercise the full autonomous flow end-to-end.
 *
 * This script drives the six primitives shipped in PRs A-G of the
 * inbox V1 sequence against a real LLM-backed CTO. The purpose is
 * not to do useful work in isolation; it's to prove the autonomous
 * flow works against the live substrate AND to produce the first
 * CTO self-critique plan, which is itself useful.
 *
 * Flow:
 *   1. Ensure canon + principals are seeded.
 *   2. Operator writes an actor-message to cto-actor asking it to
 *      critique itself and audit the substrate.
 *   3. pickNextMessage picks the request up for cto-actor.
 *   4. PlanningActor + HostLlmPlanningJudgment (Opus) produce a
 *      proposed plan.
 *   5. Glue step: wrap the plan with a delegation envelope pointing
 *      at auditor-actor so the dispatch loop has something to invoke.
 *      (The PlanningActor's own draft schema does not carry a
 *      delegation envelope today; that's a follow-up PR.)
 *   6. runAutoApprovePass transitions the plan to approved.
 *   7. runDispatchTick invokes runAuditor via the registry.
 *   8. Auditor writes a finding observation + reply actor-message.
 *   9. Print the full chain as a summary.
 *
 * Runs in sequence (single-process). Real multi-actor deployments
 * wire runInboxPoller on a tick; this script is a one-shot driver
 * for the self-audit use case.
 *
 * Usage:
 *   LAG_OPERATOR_ID=stephen-human node scripts/run-cto-self-audit.mjs
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
import {
  SubActorRegistry,
  runAuditor,
  runAutoApprovePass,
  runDispatchTick,
  pickNextMessage,
} from '../dist/actor-message/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');
const STOP_SENTINEL = resolve(STATE_DIR, 'STOP');

const OPERATOR = process.env.LAG_OPERATOR_ID;
if (!OPERATOR) {
  console.error(
    '[self-audit] ERROR: LAG_OPERATOR_ID is not set. Export your operator\n'
    + 'principal id before running this script:\n\n'
    + '  export LAG_OPERATOR_ID=<your-operator-id>\n\n'
    + 'Matches the no-fallback convention in bootstrap-inbox-canon.mjs.',
  );
  process.exit(2);
}
const CTO = 'cto-actor';
const AUDITOR = 'auditor-actor';

const REQUEST_BODY = [
  'Self-audit: critique your own substrate and propose changes.',
  '',
  'You are the CTO actor running on the proactive-CTO inbox V1 substrate',
  'that was just shipped (PRs A-G). You now have a working inbox, rate',
  'limiter, circuit breaker, SubActorRegistry, AuditorActor, plan-dispatch',
  'loop, and low-stakes auto-approval policy. The operator wants to know:',
  '',
  '1. Given what you can observe of your own substrate, what are the',
  '   three most important changes you would make to yourself before',
  '   the framework is asked to build code autonomously?',
  '2. What gap in the current substrate worries you the most, and why?',
  '3. Include a devil\'s advocate section: what are the strongest',
  '   arguments that what you shipped is actually good enough for V1',
  '   and the three changes you want are premature optimization?',
  '',
  'Cite canon directives. Alternatives rejected required. Apply',
  'dev-extreme-rigor-and-research and dev-flag-structural-concerns as',
  'adversarial checks on your own reasoning, not just supportive citations.',
].join('\n');

const CLASSIFY_MODEL = 'claude-opus-4-7';
const DRAFT_MODEL = 'claude-opus-4-7';
const INSTANCE_MAX_BUDGET_USD_PER_CALL = 50.0;
const INSTANCE_JUDGE_TIMEOUT_MS = 1_800_000;

function nowIso() {
  return new Date().toISOString();
}

async function ensurePrincipal(host, id, parentId = null) {
  const existing = await host.principals.get(id);
  if (existing !== null) return existing;
  const principal = {
    id,
    name: id,
    role: 'agent',
    permitted_scopes: { read: ['session', 'project', 'user'], write: ['session', 'project'] },
    permitted_layers: { read: ['L0', 'L1', 'L2', 'L3'], write: ['L0', 'L1'] },
    goals: [],
    constraints: [],
    active: true,
    compromised_at: null,
    signed_by: parentId,
    created_at: nowIso(),
  };
  await host.principals.put(principal);
  console.log(`[self-audit] seeded principal ${id}`);
  return principal;
}

async function writeOperatorRequest(host) {
  const correlationId = `self-audit-${Date.now()}`;
  const atomId = `req-${correlationId}`;
  const envelope = {
    to: CTO,
    from: OPERATOR,
    topic: 'self-audit-request',
    urgency_tier: 'normal',
    body: REQUEST_BODY,
    correlation_id: correlationId,
  };
  const now = nowIso();
  const atom = {
    schema_version: 1,
    id: atomId,
    content: REQUEST_BODY,
    type: 'actor-message',
    layer: 'L0',
    provenance: {
      kind: 'user-directive',
      source: { agent_id: OPERATOR, tool: 'run-cto-self-audit' },
      derived_from: [],
    },
    confidence: 1,
    created_at: now,
    last_reinforced_at: now,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: OPERATOR,
    taint: 'clean',
    metadata: { actor_message: envelope },
  };
  await host.atoms.put(atom);
  console.log(`[self-audit] operator wrote request atom ${atomId} (corr=${correlationId})`);
  return { atomId, correlationId };
}

async function drivePlanningActor(host, request) {
  const llm = new ClaudeCliLLM({});
  // Replace the host's LLM with our direct ClaudeCliLLM since PlanningActor
  // reads it via host.llm.judge. createFileHost takes llm as a param so we
  // rebuild the host with it.
  const hostWithLlm = await createFileHost({ rootDir: STATE_DIR, llm });

  const principal = await hostWithLlm.principals.get(CTO);
  if (principal === null) {
    throw new Error(`cto-actor principal missing; run bootstrap-cto-actor-canon.mjs first`);
  }

  const judgment = new HostLlmPlanningJudgment(hostWithLlm, {
    classifyModel: CLASSIFY_MODEL,
    draftModel: DRAFT_MODEL,
    maxBudgetUsdPerCall: INSTANCE_MAX_BUDGET_USD_PER_CALL,
    timeoutMs: INSTANCE_JUDGE_TIMEOUT_MS,
  });
  const actor = new PlanningActor({ request, judgment });

  const MAX_ITER = 2;
  const JUDGE_CALLS = 2;
  const SLACK_MS = 60_000;
  const deadline = new Date(
    Date.now() + MAX_ITER * JUDGE_CALLS * INSTANCE_JUDGE_TIMEOUT_MS + SLACK_MS,
  ).toISOString();

  console.log(`[self-audit] PlanningActor starting (Opus, deadline ${deadline})`);
  const report = await runActor(actor, {
    host: hostWithLlm,
    principal,
    adapters: {},
    budget: { maxIterations: MAX_ITER, deadline },
    origin: 'self-audit',
    killSwitch: () => existsSync(STOP_SENTINEL),
    onAudit: async (event) => {
      console.log(`[planning-audit] iter=${event.iteration} kind=${event.kind}`);
    },
  });
  console.log(`[self-audit] PlanningActor finished: halt=${report.haltReason} iterations=${report.iterations}`);
  return report;
}

async function findNewestFreshCtoPlan(host, since) {
  // PlanningActor writes plan atoms without an explicit plan_state
  // today (a gap the self-audit surfaces). Treat undefined plan_state
  // as eligible and let the wrap step set 'proposed' explicitly.
  const page = await host.atoms.query({ type: ['plan'] }, 500);
  const candidates = page.atoms
    .filter((a) => a.principal_id === CTO)
    .filter((a) => a.plan_state === 'proposed' || a.plan_state === undefined)
    .filter((a) => a.taint === 'clean')
    .filter((a) => a.superseded_by.length === 0)
    .filter((a) => Date.parse(a.created_at) >= since);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return candidates[0];
}

async function attachDelegationEnvelope(host, planAtom, correlationId) {
  // Post-process: the PlanningActor's draft schema does not carry a
  // delegation envelope today, so we wrap the freshly-produced plan
  // with one here. Production deployments would either extend the
  // judgment schema or write a wrapper actor that does this per
  // convention (plans whose body mentions "audit" route to auditor).
  console.log(`[self-audit] wrapping plan ${planAtom.id} with delegation envelope -> auditor-actor`);
  const delegation = {
    sub_actor_principal_id: AUDITOR,
    payload: {
      reply_to: OPERATOR,
      // Audit the CTO's own observations + directives produced since
      // the substrate came online. This is narrow enough to be fast
      // but representative of what a self-audit would look at.
      filter: {
        type: ['observation', 'directive', 'plan'],
      },
    },
    correlation_id: correlationId,
    escalate_to: OPERATOR,
  };
  // Set plan_state='proposed' explicitly alongside the delegation
  // envelope so runAutoApprovePass sees it. The PlanningActor not
  // setting plan_state by default is a real gap the self-audit
  // surfaces; logging it here so the pattern is explicit.
  await host.atoms.update(planAtom.id, {
    plan_state: 'proposed',
    metadata: { delegation },
  });
}

async function main() {
  if (!existsSync(STATE_DIR)) {
    console.error(`[self-audit] ERROR: state-dir missing: ${STATE_DIR}`);
    process.exit(2);
  }
  const host = await createFileHost({ rootDir: STATE_DIR });

  // Step 1: ensure principals.
  await ensurePrincipal(host, OPERATOR);
  await ensurePrincipal(host, AUDITOR, OPERATOR);
  const ctoPrincipal = await host.principals.get(CTO);
  if (ctoPrincipal === null) {
    console.error('[self-audit] ERROR: cto-actor principal missing. Run scripts/bootstrap-cto-actor-canon.mjs first.');
    process.exit(2);
  }

  // Step 2: operator writes the self-audit request message.
  const { atomId: requestAtomId, correlationId } = await writeOperatorRequest(host);

  // Step 3: CTO picks up the request via pickNextMessage.
  const pick = await pickNextMessage(host, CTO);
  console.log(`[self-audit] pickNextMessage outcome: ${pick.kind}`);
  if (pick.kind !== 'picked') {
    console.error(`[self-audit] FAIL: expected picked, got ${pick.kind}`);
    process.exit(3);
  }
  console.log(`[self-audit] CTO picked request: ${pick.message.atom.id}`);

  // Step 4: CTO thinks via PlanningActor (Opus).
  const requestForPlanning = REQUEST_BODY;
  const planningStart = Date.now();
  await drivePlanningActor(host, requestForPlanning);

  // Step 5: find the freshly-produced plan; wrap with delegation envelope.
  const plan = await findNewestFreshCtoPlan(host, planningStart - 5000);
  if (plan === null) {
    console.error('[self-audit] FAIL: CTO did not produce a proposed plan. Check planning-audit logs above for missing-judgment escalation.');
    process.exit(4);
  }
  console.log(`[self-audit] plan atom: ${plan.id} ("${plan.metadata?.title ?? '(untitled)'}")`);
  await attachDelegationEnvelope(host, plan, correlationId);

  // Step 6: auto-approve pass.
  const autoResult = await runAutoApprovePass(host);
  console.log(`[self-audit] auto-approve: scanned=${autoResult.scanned} approved=${autoResult.approved}`);

  // Step 7: dispatch via SubActorRegistry.
  const registry = new SubActorRegistry();
  registry.register(AUDITOR, async (payload, corr) => {
    return await runAuditor(host, payload, corr);
  });
  const dispatchResult = await runDispatchTick(host, registry);
  console.log(`[self-audit] dispatch: scanned=${dispatchResult.scanned} dispatched=${dispatchResult.dispatched} failed=${dispatchResult.failed}`);

  // Step 8: pick up the auditor's reply for the operator inbox.
  const operatorPick = await pickNextMessage(host, OPERATOR);
  console.log(`[self-audit] operator pickup: ${operatorPick.kind}`);

  // Step 9: summarize.
  console.log('');
  console.log('===== SELF-AUDIT RUN SUMMARY =====');
  console.log(`Request atom id : ${requestAtomId}`);
  console.log(`Correlation id  : ${correlationId}`);
  console.log(`CTO plan id     : ${plan.id}`);
  console.log(`CTO plan title  : ${plan.metadata?.title ?? '(untitled)'}`);
  console.log(`CTO plan conf   : ${plan.confidence}`);
  const refreshedPlan = await host.atoms.get(plan.id);
  console.log(`Plan state (final): ${refreshedPlan?.plan_state ?? 'unknown'}`);
  if (operatorPick.kind === 'picked') {
    const reply = operatorPick.message;
    console.log(`Auditor reply   : ${reply.atom.id}`);
    console.log(`Reply topic     : ${reply.envelope.topic}`);
    console.log(`Reply urgency   : ${reply.envelope.urgency_tier}`);
    console.log('');
    console.log('Reply body:');
    console.log('------------------------------------------------');
    console.log(reply.envelope.body);
    console.log('------------------------------------------------');
  } else {
    console.log('No reply landed in operator inbox.');
  }

  // Emit the CTO plan body so the operator can read the self-critique.
  console.log('');
  console.log('===== CTO SELF-CRITIQUE PLAN =====');
  console.log(plan.content);
  console.log('===== END =====');
}

try {
  await main();
} catch (err) {
  console.error(`[self-audit] ERROR: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err?.stack ?? '');
  process.exit(1);
}
