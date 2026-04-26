#!/usr/bin/env node
/**
 * Canon bootstrap for the cpo-actor role (CPO peer to cto-actor).
 *
 * Creates:
 *   1. cpo-actor Principal, signed_by claude-agent (depth 2 from the
 *      operator root). Role = 'agent'. Narrow scope: project-only;
 *      read L0..L3, write L0..L1 (cannot promote to L3 directly).
 *      Identical authority shape to cto-actor; the lens difference
 *      lives in goals/constraints prose + the judgment-prompt path,
 *      NOT in mechanism-level policy atoms.
 *
 *   2. L3 policy atoms scoping the cpo-actor's tool-use authority
 *      per checkToolPolicy's canon convention. Mirror of pol-cto-*
 *      with principal swapped to cpo-actor:
 *        - plan-propose           -> allow   (its primary job)
 *        - plan-research          -> allow   (read-only judgment)
 *        - plan-escalate          -> allow   (surface HIL via notifier)
 *        - plan-approve           -> deny    (approval is the operator's)
 *        - plan-execute-direct    -> escalate (sub-actor delegation
 *                                              wires later; direct
 *                                              execution without an
 *                                              approved plan is a bug)
 *        - ^canon-write-l3.*      -> deny    (L3 promotion requires
 *                                              human gate by inv-l3-requires-human)
 *        - ^pr-merge-.*           -> deny    (echo pr-landing-agent's
 *                                              no-auto-merge until the
 *                                              medium-tier kill switch ships)
 *        - *                      -> deny    (default-deny scoped to
 *                                              this principal; new tool
 *                                              classes require explicit
 *                                              allow atoms)
 *
 * The CPO's distinct lens (product/operator-experience: surface
 * complexity, onboarding feel, demo readiness, narrative coherence)
 * is expressed in the principal's goals/constraints prose and in the
 * future LLM judgment-prompt content. Policy atoms stay vendor-neutral
 * mechanism so the substrate remains pluggable: a CPO and a CTO are
 * different lenses on the same primitive, not different primitives.
 *
 * This bootstrap IS the PlanningActor's "soul" as canon: identity
 * via Principal, authority via L3 policy atoms. The framework
 * primitive (src/actors/planning/) ships vendor-neutral; this file
 * ships the specific cpo-actor role under which we deploy it.
 *
 * Idempotent per atom id; re-running skips existing.
 */

import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');
const BOOTSTRAP_TIME = '2026-04-26T00:00:00.000Z';

const OPERATOR_ID = process.env.LAG_OPERATOR_ID;
if (!OPERATOR_ID) {
  console.error(
    '[bootstrap-cpo-actor] ERROR: LAG_OPERATOR_ID is not set. Export it and re-run.\n'
    + '  export LAG_OPERATOR_ID=<your-operator-id>\n',
  );
  process.exit(2);
}

const CPO_ACTOR = 'cpo-actor';

const POLICIES = [
  {
    id: 'pol-cpo-plan-propose',
    tool: 'plan-propose',
    action: 'allow',
    priority: 10,
    reason: 'cpo-actor may propose plans (its primary job). validatePlan gates actual execution.',
  },
  {
    id: 'pol-cpo-plan-research',
    tool: 'plan-research',
    action: 'allow',
    priority: 10,
    reason: 'cpo-actor may do read-only research across atoms, canon, and external docs.',
  },
  {
    id: 'pol-cpo-plan-escalate',
    tool: 'plan-escalate',
    action: 'allow',
    priority: 10,
    reason: 'cpo-actor may surface plans to the operator via Notifier for HIL approval.',
  },
  {
    id: 'pol-cpo-plan-approve-denied',
    tool: 'plan-approve',
    action: 'deny',
    priority: 20,
    reason: 'Plan approval is held with the operator. cpo-actor surfaces; operator approves.',
  },
  {
    id: 'pol-cpo-plan-execute-direct-escalated',
    tool: 'plan-execute-direct',
    action: 'escalate',
    priority: 20,
    reason: 'Direct plan execution without an approved plan atom is a bug. Sub-actor delegation wires the right path; until then, escalate.',
  },
  {
    id: 'pol-cpo-no-l3-writes',
    tool: '^canon-write-l3.*',
    action: 'deny',
    priority: 30,
    reason: 'L3 promotion requires the human gate per inv-l3-requires-human. cpo-actor cannot bypass.',
  },
  {
    id: 'pol-cpo-no-merge',
    tool: '^pr-merge-.*',
    action: 'deny',
    priority: 30,
    reason: 'Echoes pr-landing-agent policy: no auto-merge until the medium-tier kill switch ships (D13).',
  },
  {
    id: 'pol-cpo-default-deny',
    tool: '*',
    action: 'deny',
    priority: 0,
    reason: 'Default-deny catch-all scoped to cpo-actor. Add an explicit allow above to enable a new tool class.',
  },
];

function policyAtom(spec) {
  return {
    schema_version: 1,
    id: spec.id,
    content: spec.reason,
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'bootstrap-cpo-actor', agent_id: 'bootstrap' },
      derived_from: [],
    },
    confidence: 1.0,
    created_at: BOOTSTRAP_TIME,
    last_reinforced_at: BOOTSTRAP_TIME,
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
    principal_id: OPERATOR_ID,
    taint: 'clean',
    metadata: {
      policy: {
        subject: 'tool-use',
        tool: spec.tool,
        origin: '*',
        principal: CPO_ACTOR,
        action: spec.action,
        reason: spec.reason,
        priority: spec.priority,
      },
    },
  };
}

/**
 * Compare stored principal to expected shape. Returns a list of
 * human-readable drift descriptors (empty = in sync). We only
 * compare authority-relevant fields; `created_at` is intentionally
 * ignored so a bootstrap rerun does not flag clock drift.
 */
function diffPrincipal(existing, expected) {
  const diffs = [];
  // compromised_at is load-bearing: a flipped kill-switch on an
  // existing principal must not survive a rerun silently. Same for
  // active, signed_by, role, name. Equality on null tolerates either
  // null or undefined being recorded as "not compromised".
  const scalar = ['name', 'role', 'signed_by', 'active', 'compromised_at'];
  for (const k of scalar) {
    const a = existing[k] ?? null;
    const b = expected[k] ?? null;
    if (a !== b) {
      diffs.push(`${k}: stored=${JSON.stringify(existing[k])} expected=${JSON.stringify(expected[k])}`);
    }
  }
  const sortedEq = (a, b) => {
    const as = (a ?? []).slice().sort().join(',');
    const bs = (b ?? []).slice().sort().join(',');
    return as === bs;
  };
  if (!sortedEq(existing.permitted_scopes?.read, expected.permitted_scopes.read)) diffs.push('permitted_scopes.read');
  if (!sortedEq(existing.permitted_scopes?.write, expected.permitted_scopes.write)) diffs.push('permitted_scopes.write');
  if (!sortedEq(existing.permitted_layers?.read, expected.permitted_layers.read)) diffs.push('permitted_layers.read');
  if (!sortedEq(existing.permitted_layers?.write, expected.permitted_layers.write)) diffs.push('permitted_layers.write');
  if (!sortedEq(existing.goals, expected.goals)) diffs.push('goals');
  if (!sortedEq(existing.constraints, expected.constraints)) diffs.push('constraints');
  return diffs;
}

/**
 * Compare stored policy atom's payload to expected. Returns a list
 * of drift descriptors (empty = in sync). The metadata.policy object
 * is the authority contract; we compare every field of it plus
 * layer/type so a silent edit to POLICIES[] is loud.
 */
function diffPolicyAtom(existing, expected) {
  const diffs = [];
  if (existing.type !== expected.type) diffs.push(`type: ${existing.type} -> ${expected.type}`);
  if (existing.layer !== expected.layer) diffs.push(`layer: ${existing.layer} -> ${expected.layer}`);
  // principal_id is the L3 author claim; provenance.kind + source are
  // the chain-of-custody. A silent edit on any of these flips the
  // policy's authority story without leaving an audit trail. Compare
  // explicitly.
  if (existing.principal_id !== expected.principal_id) {
    diffs.push(`principal_id: stored=${JSON.stringify(existing.principal_id)} expected=${JSON.stringify(expected.principal_id)}`);
  }
  const ekind = existing.provenance?.kind;
  const xkind = expected.provenance?.kind;
  if (ekind !== xkind) diffs.push(`provenance.kind: stored=${JSON.stringify(ekind)} expected=${JSON.stringify(xkind)}`);
  const esource = JSON.stringify(existing.provenance?.source ?? null);
  const xsource = JSON.stringify(expected.provenance?.source ?? null);
  if (esource !== xsource) diffs.push(`provenance.source: stored=${esource} expected=${xsource}`);
  // derived_from carries the canonical authority chain (which atoms
  // this policy claims to descend from); editing it severs the
  // provenance graph silently. Compare via JSON.stringify after
  // sorting so element-order edits don't false-fire while
  // membership edits still surface.
  const esorted = JSON.stringify((existing.provenance?.derived_from ?? []).slice().sort());
  const xsorted = JSON.stringify((expected.provenance?.derived_from ?? []).slice().sort());
  if (esorted !== xsorted) diffs.push(`provenance.derived_from: stored=${esorted} expected=${xsorted}`);
  const ep = existing.metadata?.policy ?? {};
  const xp = expected.metadata.policy;
  for (const k of ['subject', 'tool', 'origin', 'principal', 'action', 'priority']) {
    if (ep[k] !== xp[k]) {
      diffs.push(`policy.${k}: stored=${JSON.stringify(ep[k])} expected=${JSON.stringify(xp[k])}`);
    }
  }
  return diffs;
}

async function main() {
  await mkdir(STATE_DIR, { recursive: true });
  const host = await createFileHost({ rootDir: STATE_DIR });

  const operatorId = OPERATOR_ID;
  const claudeAgentId = process.env.LAG_AGENT_ID || 'claude-agent';

  // Parent chain: operator -> claude-agent -> cpo-actor.
  // On rerun, compare stored principal shape to the expected spec and
  // fail closed on drift. An authority boundary must not silently
  // survive a config edit; the operator has to see and reconcile the
  // change explicitly.
  //
  // The operator + claude-agent rows are co-bootstrapped (same chain
  // as bootstrap-cto-actor-canon.mjs); they are idempotent on rerun
  // because the cto-actor bootstrap will have already created them
  // with identical shape, so the diff returns empty and we no-op.
  // Co-locating them here means a fresh-clone CPO-only operator can
  // run THIS script alone and get a working chain.
  let principalsWritten = 0;
  let principalsOk = 0;
  for (const [pid, name, role, signedBy, writeLayers] of [
    [operatorId, 'Apex Agent', 'apex', null, ['L0', 'L1', 'L2', 'L3']],
    [claudeAgentId, 'Agent (Claude Code instance)', 'agent', operatorId, ['L0', 'L1', 'L2']],
    [CPO_ACTOR, 'CPO actor (planning, product lens)', 'agent', claudeAgentId, ['L0', 'L1']],
  ]) {
    const expected = {
      id: pid,
      name,
      role,
      permitted_scopes: {
        read: ['session', 'project', 'user', 'global'],
        write: pid === operatorId
          ? ['session', 'project', 'user', 'global']
          : pid === CPO_ACTOR
            ? ['session', 'project']
            : ['session', 'project', 'user'],
      },
      permitted_layers: {
        read: ['L0', 'L1', 'L2', 'L3'],
        write: writeLayers,
      },
      goals: pid === CPO_ACTOR
        ? ['Draft plans through the product/operator-experience lens (surface complexity, onboarding feel, demo readiness, narrative coherence). Independent peer to cto-actor; operator arbitrates conflicts. Escalate for operator approval. Never self-approve.']
        : [],
      constraints: pid === CPO_ACTOR
        ? ['No L2/L3 writes. No merges. No approvals. Plan execution via sub-actor delegation, not direct.']
        : [],
      active: true,
      compromised_at: null,
      signed_by: signedBy,
      created_at: BOOTSTRAP_TIME,
    };
    const existing = await host.principals.get(pid);
    if (existing) {
      const drift = diffPrincipal(existing, expected);
      if (drift.length > 0) {
        throw new Error(
          `[bootstrap-cpo-actor] principal '${pid}' drift: ${drift.join(', ')}. ` +
          `Refusing to silently continue. Either delete .lag state and re-bootstrap, ` +
          `or update the bootstrap spec to match the stored shape.`,
        );
      }
      principalsOk++;
      continue;
    }
    await host.principals.put(expected);
    principalsWritten++;
  }

  // Policy drift check: compare the stored atom's policy payload to
  // the incoming spec. Silent skip-by-id would let a later edit to
  // `tool`, `action`, `priority`, or `principal` fail to take effect,
  // leaving stale authority in force. Authority drift must fail loud.
  let written = 0;
  let skipped = 0;
  for (const spec of POLICIES) {
    const expected = policyAtom(spec);
    const existing = await host.atoms.get(spec.id);
    if (existing) {
      const drift = diffPolicyAtom(existing, expected);
      if (drift.length > 0) {
        throw new Error(
          `[bootstrap-cpo-actor] policy atom '${spec.id}' drift: ${drift.join(', ')}. ` +
          `Refusing to silently continue. Either delete the atom and re-bootstrap, ` +
          `or align POLICIES[] to match the stored payload.`,
        );
      }
      skipped++;
      continue;
    }
    await host.atoms.put(expected);
    written++;
  }
  // Surface the principal-write stats so the operator can see what
  // the bootstrap did vs what was already correct.
  console.log(`[bootstrap-cpo-actor] Principals: ${principalsWritten} new, ${principalsOk} validated unchanged.`);

  console.log(`[bootstrap-cpo-actor] Principal chain: ${operatorId} -> ${claudeAgentId} -> ${CPO_ACTOR}`);
  console.log(`[bootstrap-cpo-actor] Wrote ${written} new L3 policy atoms (${skipped} already existed, skipped).`);
  console.log('[bootstrap-cpo-actor] Done.');
}

main().catch((err) => {
  console.error('[bootstrap-cpo-actor] FAILED:', err);
  process.exit(1);
});
