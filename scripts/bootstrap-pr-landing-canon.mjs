#!/usr/bin/env node
/**
 * Canon bootstrap for the pr-landing autonomous role (Phase 53b).
 *
 * Run from repo root (after `npm run build`):
 *   node scripts/bootstrap-pr-landing-canon.mjs
 *
 * Creates:
 *   1. A `pr-landing-agent` Principal, signed_by `claude-agent` (depth 2
 *      from the operator root). Role = 'agent'. Permitted layers read
 *      across all L0..L3; write L0..L1 only (cannot promote to L3).
 *   2. L3 policy atoms that scope what the pr-landing agent may do,
 *      matched by checkToolPolicy inside runActor:
 *        - pr-reply-nit           -> allow   (small, deterministic)
 *        - pr-resolve-nit         -> allow   (follows the nit reply)
 *        - pr-reply-suggestion    -> allow   (best-effort ack)
 *        - pr-reply-architectural -> escalate (needs the operator)
 *        - pr-merge-*             -> deny    (no auto-merge, per D13)
 *        - *                      -> deny    (default-deny catch-all
 *                                              scoped to this principal)
 *
 * This bootstrap IS the CTO-layer conversation made concrete: an agent
 * identity with delegated authority scoped by canon atoms. The framework
 * primitives are Principal + Atom + Policy; the specific role shape
 * (pr-landing-agent, the decision classes) is our instance.
 *
 * Idempotent per atom id: re-running skips atoms whose id already
 * exists. Content is immutable in the atom model, so to refresh a
 * policy shape, change its id here or use the atom-update path
 * explicitly (not exercised in this bootstrap).
 */

import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');
const BOOTSTRAP_TIME = '2026-04-19T00:00:00.000Z';

const OPERATOR_ID = process.env.LAG_OPERATOR_ID;
if (!OPERATOR_ID) {
  console.error(
    '[bootstrap-pr-landing] ERROR: LAG_OPERATOR_ID is not set. Export it and re-run.\n'
    + '  export LAG_OPERATOR_ID=<your-operator-id>\n',
  );
  process.exit(2);
}

const PR_LANDING_AGENT = 'pr-landing-agent';

/**
 * Policy atom shape matches checkToolPolicy's parsePolicy contract:
 *   metadata.policy = { subject, tool, origin, principal, action, reason, priority }
 *
 * Priority breaks specificity ties. We use priority to make the
 * catch-all default-deny lose to the specific allows.
 */
const POLICIES = [
  {
    id: 'pol-pr-landing-reply-nit',
    tool: 'pr-reply-nit',
    action: 'allow',
    priority: 10,
    reason: 'pr-landing-agent may reply to nit-level review comments; low blast radius.',
  },
  {
    id: 'pol-pr-landing-resolve-nit',
    tool: 'pr-resolve-nit',
    action: 'allow',
    priority: 10,
    reason: 'pr-landing-agent may resolve nit threads after replying; symmetric with reply-nit.',
  },
  {
    id: 'pol-pr-landing-reply-suggestion',
    tool: 'pr-reply-suggestion',
    action: 'allow',
    priority: 10,
    reason: 'pr-landing-agent may acknowledge suggestions; does not resolve (suggestion author or operator does).',
  },
  {
    id: 'pol-pr-landing-reply-architectural',
    tool: 'pr-reply-architectural',
    action: 'escalate',
    priority: 10,
    reason: 'Architectural feedback requires the operator to judge. Surface the thread; do not auto-reply.',
  },
  {
    id: 'pol-pr-landing-ensure-review',
    tool: 'pr-ensure-review',
    action: 'allow',
    priority: 10,
    reason: 'pr-landing-agent may prompt a configured reviewer bot (e.g. "@coderabbitai review") when hasReviewerEngaged returns false. Low blast radius; idempotent in practice.',
  },
  {
    id: 'pol-pr-landing-merge-denied',
    tool: '^pr-merge-.*',
    action: 'deny',
    priority: 20,
    reason: 'No auto-merge. Merging is held with the operator until medium-tier kill switch ships (D13).',
  },
  {
    id: 'pol-pr-landing-default-deny',
    tool: '*',
    action: 'deny',
    priority: 0,
    reason: 'Default-deny catch-all scoped to pr-landing-agent; add an explicit allow above to enable a new tool class.',
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
      source: { session_id: 'bootstrap-pr-landing', agent_id: 'bootstrap' },
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
        principal: PR_LANDING_AGENT,
        action: spec.action,
        reason: spec.reason,
        priority: spec.priority,
      },
    },
  };
}

async function main() {
  await mkdir(STATE_DIR, { recursive: true });
  const host = await createFileHost({ rootDir: STATE_DIR });

  const operatorId = OPERATOR_ID;
  const claudeAgentId = process.env.LAG_AGENT_ID || 'claude-agent';

  // Ensure parent chain exists. bootstrap.mjs normally creates these;
  // re-assert here so this script is runnable standalone.
  const existingOperator = await host.principals.get(operatorId);
  if (!existingOperator) {
    await host.principals.put({
      id: operatorId,
      name: 'Apex Agent',
      role: 'apex',
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
    });
  }

  const existingClaude = await host.principals.get(claudeAgentId);
  if (!existingClaude) {
    await host.principals.put({
      id: claudeAgentId,
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
      signed_by: operatorId,
      created_at: BOOTSTRAP_TIME,
    });
  }

  // The pr-landing-agent: signed_by claude-agent (depth 2 from operator).
  // Narrow scope: project only. Layers: read L0..L3, write L0..L1 so
  // it can observe + record outcomes but cannot write curated or canon.
  await host.principals.put({
    id: PR_LANDING_AGENT,
    name: 'PR-landing agent',
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
      'Drive open PRs toward merge-ready by addressing review feedback within delegated authority.',
    ],
    constraints: [
      'No merge-class actions. No L2 or L3 writes. Escalate architectural feedback.',
    ],
    active: true,
    compromised_at: null,
    signed_by: claudeAgentId,
    created_at: BOOTSTRAP_TIME,
  });

  let written = 0;
  let skipped = 0;
  for (const spec of POLICIES) {
    const existing = await host.atoms.get(spec.id);
    if (existing) {
      skipped++;
      continue;
    }
    await host.atoms.put(policyAtom(spec));
    written++;
  }

  console.log(
    `[bootstrap-pr-landing] Principal '${PR_LANDING_AGENT}' signed_by '${claudeAgentId}' created or refreshed.`,
  );
  console.log(`[bootstrap-pr-landing] Wrote ${written} new L3 policy atoms (${skipped} already existed, skipped).`);
  console.log('[bootstrap-pr-landing] Done.');
}

main().catch((err) => {
  console.error('[bootstrap-pr-landing] FAILED:', err);
  process.exit(1);
});
