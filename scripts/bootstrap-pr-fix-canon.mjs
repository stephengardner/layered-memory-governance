#!/usr/bin/env node
/**
 * Canon bootstrap for the pr-fix autonomous role.
 *
 * Run from repo root (after `npm run build`):
 *   LAG_OPERATOR_ID=<your-id> node scripts/bootstrap-pr-fix-canon.mjs
 *
 * Creates:
 *   1. A `pr-fix-actor` Principal, signed_by `claude-agent` (depth 2
 *      from the operator root). Role = 'agent'. Permitted layers
 *      read across L0..L3; write L0..L1 only (cannot promote to L3).
 *   2. L3 policy atoms that scope what the pr-fix-actor may do,
 *      matched by checkToolPolicy inside runActor:
 *        - agent-loop-dispatch     -> allow   (primary job: fixes)
 *        - pr-escalate             -> allow   (ci-failure / architectural)
 *        - pr-thread-resolve       -> allow   (after touched-paths fix)
 *        - ^pr-merge-.*            -> deny    (no auto-merge)
 *        - ^canon-write-l3.*       -> deny    (L3 promotion stays human-gated)
 *        - *                       -> deny    (default-deny catch-all
 *                                              scoped to this principal)
 *
 * The Layer-A canon table here gates the actor's OWN proposed actions
 * via runActor's checkToolPolicy. Layer-B (sub-agent disallowedTools)
 * is enforced by the AgentLoopAdapter wired in the driver script
 * and is NOT seeded as canon -- the floor is hard-coded in the actor
 * so a missing canon entry cannot accidentally widen sub-agent reach.
 *
 * Idempotent per atom / principal id; drift against the expected shape
 * fails loud on a second run (matches the `bootstrap-code-author-canon.mjs`
 * + `bootstrap-inbox-canon.mjs` drift patterns). Principal identity,
 * provenance integrity, and the full policy payload are all in the drift
 * surface so a silent re-attribution under unchanged numeric fields is
 * loud. A rewritten provenance under unchanged policy payload is exactly
 * the class of silent re-attribution this check catches.
 *
 * No hardcoded operator fallback is permitted. The pr-fix-actor is a
 * principal that can dispatch sub-agent loops which write to a shared
 * repo; a silent-default operator id would make the provenance chain
 * unverifiable.
 */

import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');
const BOOTSTRAP_TIME = '2026-04-25T00:00:00.000Z';

const PR_FIX_AGENT = 'pr-fix-actor';

const OPERATOR_ID = process.env.LAG_OPERATOR_ID;
if (!OPERATOR_ID || OPERATOR_ID.length === 0) {
  console.error(
    '[bootstrap-pr-fix] ERROR: LAG_OPERATOR_ID is not set.\n'
    + 'Set it to the operator principal id used at initial bootstrap, e.g.\n\n'
    + '  export LAG_OPERATOR_ID=<your-operator-id>\n\n'
    + 'A silent fallback would attribute six L3 policy atoms to a sentinel id\n'
    + 'that may not exist in this repo, silently forking the authority chain.',
  );
  process.exit(2);
}

// Canonical agent id. Soft-fallback matches bootstrap-code-author-canon.mjs:
// 'claude-agent' is the project's canonical agent-principal id, and every
// bootstrap script in this repo roots its agent chain on it. If a deployment
// chooses a different agent id, it MUST set LAG_AGENT_ID consistently for
// all bootstrap scripts.
//
// The risk this fallback could create (silent re-attribution through a
// freshly-minted 'claude-agent' parent) is closed by the parent-chain
// drift check in ensureParentChain: if an existing claude-agent principal
// has drifted shape, the script fails loud rather than adopting the
// compromise into pr-fix-actor.signed_by.
const CLAUDE_AGENT_ID = process.env.LAG_AGENT_ID || 'claude-agent';

/**
 * Policy atom shape matches checkToolPolicy's parsePolicy contract:
 *   metadata.policy = { subject, tool, origin, principal, action, reason, priority }
 *
 * Priority breaks specificity ties. Catch-all default-deny stays at
 * priority 0 so the specific allows + the explicit denies dominate.
 */
const POLICIES = [
  {
    id: 'pol-pr-fix-agent-loop-dispatch',
    tool: 'agent-loop-dispatch',
    action: 'allow',
    priority: 10,
    reason: 'pr-fix-actor may dispatch a sub-agent loop to address review findings on the PR HEAD branch.',
  },
  {
    id: 'pol-pr-fix-pr-escalate',
    tool: 'pr-escalate',
    action: 'allow',
    priority: 10,
    reason: 'pr-fix-actor may surface CI failures and architectural findings to the operator via the existing actor-message channel.',
  },
  {
    id: 'pol-pr-fix-pr-thread-resolve',
    tool: 'pr-thread-resolve',
    action: 'allow',
    priority: 10,
    reason: 'pr-fix-actor resolves CR threads inside apply for findings whose touched-paths actually changed in the dispatched fix.',
  },
  {
    id: 'pol-pr-fix-merge-denied',
    tool: '^pr-merge-.*',
    action: 'deny',
    priority: 20,
    reason: 'No auto-merge. Merging stays operator-held.',
  },
  {
    id: 'pol-pr-fix-canon-l3-denied',
    tool: '^canon-write-l3.*',
    action: 'deny',
    priority: 20,
    reason: 'L3 canon promotion requires the human gate; raise the dial via specific allow atoms instead of widening this denial.',
  },
  {
    id: 'pol-pr-fix-default-deny',
    tool: '*',
    action: 'deny',
    priority: 0,
    reason: 'Default-deny catch-all scoped to pr-fix-actor; add an explicit allow above to enable a new tool class.',
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
      source: { session_id: 'bootstrap-pr-fix', agent_id: 'bootstrap' },
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
        principal: PR_FIX_AGENT,
        action: spec.action,
        reason: spec.reason,
        priority: spec.priority,
      },
    },
  };
}

/**
 * Compare a stored pr-fix policy atom's payload to the expected shape.
 * Mirrors bootstrap-inbox-canon.mjs's diffPolicyAtom: every load-bearing
 * sub-field is compared so a silent edit to POLICIES (or a tampered atom)
 * is loud on the next bootstrap run.
 *
 * The four integrity fields (principal_id, provenance.kind,
 * provenance.source, provenance.derived_from) sit alongside the policy
 * payload (subject, tool, origin, principal, action, reason, priority)
 * because bootstrap is the only point where principal-id swaps or
 * provenance tampering can be caught cheaply; once the substrate trusts
 * .lag/atoms/, runtime tooling won't.
 */
function diffPolicyAtom(existing, expected) {
  const diffs = [];
  for (const k of ['type', 'layer', 'content']) {
    if (existing[k] !== expected[k]) {
      diffs.push(`${k}: stored=${JSON.stringify(existing[k])} expected=${JSON.stringify(expected[k])}`);
    }
  }
  if (existing.principal_id !== expected.principal_id) {
    diffs.push(
      `principal_id: stored=${JSON.stringify(existing.principal_id)} `
      + `expected=${JSON.stringify(expected.principal_id)}`,
    );
  }
  const ev = existing.provenance ?? {};
  const xv = expected.provenance;
  if (ev.kind !== xv.kind) {
    diffs.push(`provenance.kind: stored=${JSON.stringify(ev.kind)} expected=${JSON.stringify(xv.kind)}`);
  }
  if (JSON.stringify(ev.source ?? {}) !== JSON.stringify(xv.source)) {
    diffs.push(`provenance.source: stored=${JSON.stringify(ev.source)} expected=${JSON.stringify(xv.source)}`);
  }
  if (JSON.stringify(ev.derived_from ?? []) !== JSON.stringify(xv.derived_from)) {
    diffs.push(`provenance.derived_from: stored=${JSON.stringify(ev.derived_from)} expected=${JSON.stringify(xv.derived_from)}`);
  }
  const ep = existing.metadata?.policy ?? {};
  const xp = expected.metadata.policy;
  const keys = new Set([...Object.keys(ep), ...Object.keys(xp)]);
  for (const k of keys) {
    if (JSON.stringify(ep[k]) !== JSON.stringify(xp[k])) {
      diffs.push(`policy.${k}: stored=${JSON.stringify(ep[k])} expected=${JSON.stringify(xp[k])}`);
    }
  }
  return diffs;
}

// Expected operator shape; factored into a builder so ensureParentChain
// seeds + drift-checks against the same source of truth. Drift on
// compromised_at, permitted_scopes, permitted_layers is load-bearing
// because a mutated parent silently re-attributes every child's signed_by
// edge to a weakened parent, and pr-fix-actor inherits.
function operatorPrincipal() {
  return {
    id: OPERATOR_ID,
    name: 'Operator (human)',
    role: 'user',
    permitted_scopes: {
      read: ['session', 'project', 'user', 'global'],
      write: ['session', 'project', 'user', 'global'],
    },
    permitted_layers: {
      read: ['L0', 'L1', 'L2', 'L3'],
      write: ['L0', 'L1', 'L2', 'L3'],
    },
    goals: [],
    constraints: [],
    active: true,
    compromised_at: null,
    signed_by: null,
    created_at: BOOTSTRAP_TIME,
  };
}

function claudeAgentPrincipal() {
  return {
    id: CLAUDE_AGENT_ID,
    name: 'Agent (Claude Code instance)',
    role: 'agent',
    permitted_scopes: {
      read: ['session', 'project', 'user', 'global'],
      write: ['session', 'project', 'user'],
    },
    permitted_layers: {
      read: ['L0', 'L1', 'L2', 'L3'],
      write: ['L0', 'L1', 'L2'],
    },
    goals: [],
    constraints: [],
    active: true,
    compromised_at: null,
    signed_by: OPERATOR_ID,
    created_at: BOOTSTRAP_TIME,
  };
}

// Shape of the pr-fix-actor principal. Goals + constraints summarize the
// role for human readers (not enforced; the policy atoms above are the
// enforcement). Narrow scope: project only. Layers: read L0..L3, write
// L0..L1 so the actor can observe + record outcomes but cannot write
// curated or canon.
function prFixActorPrincipal() {
  return {
    id: PR_FIX_AGENT,
    name: 'PR-fix actor',
    role: 'agent',
    permitted_scopes: {
      read: ['session', 'project'],
      write: ['session', 'project'],
    },
    permitted_layers: {
      read: ['L0', 'L1', 'L2', 'L3'],
      write: ['L0', 'L1'],
    },
    goals: [
      'Drive an open PR through review feedback by dispatching agent-loop fixes and resolving threads on touched paths.',
    ],
    constraints: [
      'No merge-class actions. No L2 or L3 writes. Escalate ci-failure / architectural findings.',
    ],
    active: true,
    compromised_at: null,
    signed_by: CLAUDE_AGENT_ID,
    created_at: BOOTSTRAP_TIME,
  };
}

function diffPrincipal(existing, expected) {
  const diffs = [];
  // compromised_at drift is load-bearing: a stored parent with a
  // non-null compromised_at (or a cleared value under a rotated key)
  // is exactly the class of silent re-attribution this bootstrap
  // exists to prevent.
  for (const k of ['name', 'role', 'signed_by', 'active', 'compromised_at']) {
    if (existing[k] !== expected[k]) {
      diffs.push(`${k}: stored=${JSON.stringify(existing[k])} expected=${JSON.stringify(expected[k])}`);
    }
  }
  for (const k of ['permitted_scopes', 'permitted_layers']) {
    if (JSON.stringify(existing[k]) !== JSON.stringify(expected[k])) {
      diffs.push(`${k}: stored=${JSON.stringify(existing[k])} expected=${JSON.stringify(expected[k])}`);
    }
  }
  return diffs;
}

async function ensureParentChain(host) {
  // Seed OR drift-check the operator + claude-agent chain so this script
  // is runnable standalone AND surfaces a compromised / tampered parent
  // as loudly as it would a compromised pr-fix-actor. Earlier versions
  // of this script seeded parents only when absent and silently accepted
  // any existing shape; that is the exact silent-re-attribution class
  // the policy atoms exist to close, applied one hop up. If the parent
  // is tampered, the write that inherits from it is already suspect.
  for (const expected of [operatorPrincipal(), claudeAgentPrincipal()]) {
    const existing = await host.principals.get(expected.id);
    if (!existing) {
      await host.principals.put(expected);
      continue;
    }
    const pdiffs = diffPrincipal(existing, expected);
    if (pdiffs.length > 0) {
      console.error(
        `[bootstrap-pr-fix] DRIFT on parent principal ${expected.id}:\n  ${pdiffs.join('\n  ')}\n`
        + 'pr-fix-actor cannot safely inherit a signed_by edge to a drifted '
        + 'parent. Resolve by: (a) aligning the stored parent with the canonical '
        + 'shape, or (b) explicitly revoking the stored parent through an operator '
        + 'tool before re-bootstrapping. No principals or policy atoms have been written.',
      );
      process.exit(1);
    }
  }
}

async function main() {
  await mkdir(STATE_DIR, { recursive: true });
  const host = await createFileHost({ rootDir: STATE_DIR });

  await ensureParentChain(host);

  // Seed or drift-check the pr-fix-actor principal. Earlier versions
  // unconditionally `put`-ed on every re-run, silently overwriting any
  // operator-curated edits to goals / constraints / permitted_layers.
  const expectedActor = prFixActorPrincipal();
  const existingActor = await host.principals.get(PR_FIX_AGENT);
  let actorWritten = false;
  if (!existingActor) {
    await host.principals.put(expectedActor);
    actorWritten = true;
  } else {
    const pdiffs = diffPrincipal(existingActor, expectedActor);
    if (pdiffs.length > 0) {
      console.error(
        `[bootstrap-pr-fix] DRIFT on principal ${PR_FIX_AGENT}:\n  ${pdiffs.join('\n  ')}\n`
        + 'Resolve by: (a) aligning this script with the stored principal if that is '
        + 'authoritative, or (b) revoking the stored principal explicitly through an '
        + 'operator tool before re-bootstrapping.',
      );
      process.exit(1);
    }
  }

  let written = 0;
  let ok = 0;
  for (const spec of POLICIES) {
    const expected = policyAtom(spec);
    const existing = await host.atoms.get(expected.id);
    if (existing === null) {
      await host.atoms.put(expected);
      written += 1;
      console.log(`[bootstrap-pr-fix] wrote ${expected.id}`);
      continue;
    }
    const diffs = diffPolicyAtom(existing, expected);
    if (diffs.length > 0) {
      console.error(
        `[bootstrap-pr-fix] DRIFT on ${expected.id}:\n  ${diffs.join('\n  ')}\n`
        + 'Resolve by: (a) editing POLICIES[] to match stored shape if the '
        + 'stored value is authoritative, or (b) bumping the atom id and '
        + 'superseding the old one if you are intentionally changing policy.',
      );
      process.exit(1);
    }
    ok += 1;
  }

  console.log(
    `[bootstrap-pr-fix] principal ${PR_FIX_AGENT} ${actorWritten ? 'written' : 'in sync'}; `
    + `${written} policy atoms written, ${ok} already in sync.`,
  );
}

main().catch((err) => {
  console.error('[bootstrap-pr-fix] FAILED:', err);
  process.exit(1);
});
