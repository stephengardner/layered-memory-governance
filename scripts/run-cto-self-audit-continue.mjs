#!/usr/bin/env node
/**
 * Continuation of run-cto-self-audit.mjs: picks up the existing CTO
 * plan, wraps with a delegation envelope, auto-approves, dispatches,
 * and reports.
 *
 * Separate script so we don't spend another Opus call on the
 * planning step when the first run already produced the plan.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';
import {
  SubActorRegistry,
  runAuditor,
  runAutoApprovePass,
  runDispatchTick,
  pickNextMessage,
} from '../dist/actor-message/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');

const OPERATOR = process.env.LAG_OPERATOR_ID;
if (!OPERATOR) {
  console.error(
    '[self-audit-continue] ERROR: LAG_OPERATOR_ID is not set. Export your\n'
    + 'operator principal id before running this script:\n\n'
    + '  export LAG_OPERATOR_ID=<your-operator-id>\n',
  );
  process.exit(2);
}
const AUDITOR = 'auditor-actor';
const CTO = 'cto-actor';

const PLAN_ID = 'plan-harden-three-substrate-layers-before-aut-cto-actor-20260420171042';
const CORRELATION_ID = 'self-audit-1776704837062';

async function main() {
  const host = await createFileHost({ rootDir: STATE_DIR });

  // Ensure auditor principal exists (first run may have seeded it).
  if ((await host.principals.get(AUDITOR)) === null) {
    await host.principals.put({
      id: AUDITOR,
      name: AUDITOR,
      role: 'agent',
      permitted_scopes: { read: ['session', 'project', 'user'], write: ['session', 'project'] },
      permitted_layers: { read: ['L0', 'L1', 'L2', 'L3'], write: ['L0', 'L1'] },
      goals: [],
      constraints: [],
      active: true,
      compromised_at: null,
      signed_by: OPERATOR,
      created_at: new Date().toISOString(),
    });
    console.log(`[self-audit-continue] seeded ${AUDITOR}`);
  }

  // Step 1: locate the plan written by the prior run.
  const plan = await host.atoms.get(PLAN_ID);
  if (plan === null) {
    console.error(`[self-audit-continue] plan ${PLAN_ID} not found`);
    process.exit(2);
  }
  console.log(`[self-audit-continue] plan: ${plan.id}`);
  console.log(`[self-audit-continue] title: ${plan.metadata?.title ?? '(untitled)'}`);
  console.log(`[self-audit-continue] confidence: ${plan.confidence}`);
  console.log(`[self-audit-continue] current plan_state: ${plan.plan_state ?? '(undefined - this is the gap the run surfaced)'}`);

  // Step 2: wrap with delegation + set plan_state='proposed'.
  const delegation = {
    sub_actor_principal_id: AUDITOR,
    payload: {
      reply_to: OPERATOR,
      filter: { type: ['observation', 'directive', 'plan'] },
    },
    correlation_id: CORRELATION_ID,
    escalate_to: OPERATOR,
  };
  await host.atoms.update(plan.id, {
    plan_state: 'proposed',
    metadata: { delegation },
  });
  console.log(`[self-audit-continue] plan wrapped; state -> proposed`);

  // Step 3: auto-approve pass.
  const autoResult = await runAutoApprovePass(host);
  console.log(`[self-audit-continue] auto-approve: scanned=${autoResult.scanned} approved=${autoResult.approved}`);

  // Step 4: dispatch.
  const registry = new SubActorRegistry();
  registry.register(AUDITOR, async (payload, corr) => runAuditor(host, payload, corr));
  const dispatchResult = await runDispatchTick(host, registry);
  console.log(`[self-audit-continue] dispatch: scanned=${dispatchResult.scanned} dispatched=${dispatchResult.dispatched} failed=${dispatchResult.failed}`);

  // Step 5: operator picks up the auditor reply.
  const pick = await pickNextMessage(host, OPERATOR);
  console.log(`[self-audit-continue] operator pickup: ${pick.kind}`);

  // Step 6: summarize.
  console.log('');
  console.log('===== AUTONOMOUS FLOW RESULT =====');
  const finalPlan = await host.atoms.get(plan.id);
  console.log(`Plan state (final) : ${finalPlan?.plan_state}`);
  const dispatchStamp = finalPlan?.metadata?.dispatch_result;
  if (dispatchStamp) {
    console.log(`Dispatch kind      : ${dispatchStamp.kind}`);
    console.log(`Dispatch summary   : ${dispatchStamp.summary}`);
    console.log(`Produced atoms     : ${JSON.stringify(dispatchStamp.produced_atom_ids ?? [])}`);
  }
  if (pick.kind === 'picked') {
    const reply = pick.message;
    console.log('');
    console.log(`Auditor reply id   : ${reply.atom.id}`);
    console.log(`Reply topic        : ${reply.envelope.topic}`);
    console.log(`Reply urgency      : ${reply.envelope.urgency_tier}`);
    console.log('');
    console.log('Reply body:');
    console.log('------------------------------------------------');
    console.log(reply.envelope.body);
    console.log('------------------------------------------------');
  }

  console.log('');
  console.log('===== CTO SELF-CRITIQUE PLAN =====');
  // finalPlan could be null if the plan was deleted or supersede-
  // cascaded between the fetch above and this render. Guard
  // explicitly so a race cannot crash the script.
  if (finalPlan !== null) {
    console.log(finalPlan.content);
  } else {
    console.log('(plan not found; may have been superseded since fetch)');
  }
  console.log('===== END =====');
}

try {
  await main();
} catch (err) {
  console.error(`[self-audit-continue] ERROR: ${err?.message ?? err}`);
  console.error(err?.stack ?? '');
  process.exit(1);
}
