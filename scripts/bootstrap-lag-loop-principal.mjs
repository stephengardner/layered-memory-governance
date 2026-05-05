#!/usr/bin/env node
/**
 * Provision the `lag-loop` principal.
 *
 * Run from repo root (after `npm run build`):
 *   LAG_OPERATOR_ID=<your-id> node scripts/bootstrap-lag-loop-principal.mjs
 *
 * Why this script exists:
 *   The autonomous loop (lag-run-loop) writes audit rows on every
 *   tick. When `--reap-stale-plans` is enabled, the reaper transitions
 *   stale `proposed` plans to `abandoned` and each transition emits a
 *   `plan.state_transition` audit event attributed to a principal.
 *   `lag-loop` is the natural attribution for autonomous-loop-driven
 *   cleanups: a freshly-cloned deployment that runs
 *   `lag-run-loop --reap-stale-plans` should not first have to learn
 *   how to hand-craft a Principal record.
 *
 * What this script does:
 *   1. Drift-checks (or seeds) the operator + claude-agent parents so
 *      `lag-loop` cannot inherit signed_by from a tampered chain.
 *   2. Drift-checks (or seeds) the `lag-loop` principal itself,
 *      signed_by claude-agent (depth 2 from operator root). Role is
 *      `agent`. Read scope: session + project. Write scope: session +
 *      project. Permitted layers: read L0..L3, write L0..L1 (the loop
 *      writes audit rows + transitions plan_state on L1 atoms; it
 *      does NOT promote to L3 - L3 stays human-gated).
 *
 * What this script intentionally does NOT do:
 *   - Seed canon policy atoms. The reaper TTL knobs stay env-vars +
 *     CLI flags for now; promoting them to canon is a separate PR.
 *   - Provision other LoopRunner principals (canon-applier, decay,
 *     promotion). Those continue to run under the `--principal`
 *     value passed to lag-run-loop (which itself defaults to
 *     `lag-loop`); attribution unification of every loop pass under
 *     a single principal is intentional.
 *
 * Idempotent per principal id; drift fails loud (matches the
 * bootstrap-pr-fix-canon.mjs + bootstrap-code-author-canon.mjs
 * patterns). A re-run on an unchanged principal is a no-op; a
 * re-run on a tampered principal exits with non-zero so CI catches
 * silent re-attribution attempts.
 *
 * No hardcoded operator fallback. LAG_OPERATOR_ID is required so the
 * provenance chain is anchored to a real operator id, not a sentinel.
 */

import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');
const BOOTSTRAP_TIME = '2026-05-04T00:00:00.000Z';

const LAG_LOOP_AGENT = 'lag-loop';

const OPERATOR_ID = process.env.LAG_OPERATOR_ID;
if (!OPERATOR_ID || OPERATOR_ID.length === 0) {
  console.error(
    '[bootstrap-lag-loop] ERROR: LAG_OPERATOR_ID is not set.\n'
      + 'Set it to the operator principal id used at initial bootstrap, e.g.\n\n'
      + '  export LAG_OPERATOR_ID=<your-operator-id>\n\n'
      + 'A silent fallback would attribute every audit row produced by the loop\n'
      + 'reaper pass to a sentinel id that may not exist in this repo, silently\n'
      + 'forking the authority chain.',
  );
  process.exit(2);
}

const CLAUDE_AGENT_ID = process.env.LAG_AGENT_ID || 'claude-agent';

function operatorPrincipal() {
  return {
    id: OPERATOR_ID,
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

// Shape of the lag-loop principal. Goals + constraints summarize the role
// for human readers (not enforced; permitted_layers + permitted_scopes
// gate writes). Read L0..L3 lets the loop see canon during the canon-
// applier render step; write L0..L1 lets it record audit rows and apply
// reaper-triggered plan_state transitions on L1 plan atoms.
function lagLoopPrincipal() {
  return {
    id: LAG_LOOP_AGENT,
    name: 'LAG autonomous loop',
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
      'Drive the LoopRunner tick: TTL/decay passes, L2/L3 promotion, canon render, stale-plan reaper.',
    ],
    constraints: [
      'No L2 or L3 writes. No merge-class actions. Reaper transitions only proposed -> abandoned with audit attribution.',
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
  // Drift-check OR seed the operator + claude-agent chain so this
  // script is runnable standalone AND surfaces a tampered parent
  // loudly. lag-loop signed_by claude-agent depends on a clean
  // claude-agent depth-1 edge to the operator root.
  //
  // Two-pass: scan all parents for drift first, then perform any
  // writes only if every parent is clean. A single-pass interleave
  // would partially seed the store before catching a downstream
  // parent's drift, leaving the operator with a half-applied state
  // that the next run cannot distinguish from a clean partial
  // bootstrap.
  const expectedParents = [operatorPrincipal(), claudeAgentPrincipal()];
  const toWrite = [];
  for (const expected of expectedParents) {
    const existing = await host.principals.get(expected.id);
    if (!existing) {
      toWrite.push(expected);
      continue;
    }
    const pdiffs = diffPrincipal(existing, expected);
    if (pdiffs.length > 0) {
      console.error(
        `[bootstrap-lag-loop] DRIFT on parent principal ${expected.id}:\n  ${pdiffs.join('\n  ')}\n`
          + 'lag-loop cannot safely inherit a signed_by edge to a drifted parent. '
          + 'Resolve by: (a) aligning the stored parent with the canonical shape, '
          + 'or (b) explicitly revoking the stored parent through an operator tool '
          + 'before re-bootstrapping. No principals have been written.',
      );
      process.exit(1);
    }
  }
  for (const expected of toWrite) {
    await host.principals.put(expected);
  }
}

async function main() {
  await mkdir(STATE_DIR, { recursive: true });
  const host = await createFileHost({ rootDir: STATE_DIR });

  await ensureParentChain(host);

  const expected = lagLoopPrincipal();
  const existing = await host.principals.get(LAG_LOOP_AGENT);
  let written = false;
  if (!existing) {
    await host.principals.put(expected);
    written = true;
  } else {
    const pdiffs = diffPrincipal(existing, expected);
    if (pdiffs.length > 0) {
      console.error(
        `[bootstrap-lag-loop] DRIFT on principal ${LAG_LOOP_AGENT}:\n  ${pdiffs.join('\n  ')}\n`
          + 'Resolve by: (a) aligning this script with the stored principal if that is '
          + 'authoritative, or (b) revoking the stored principal explicitly through an '
          + 'operator tool before re-bootstrapping.',
      );
      process.exit(1);
    }
  }

  console.log(
    `[bootstrap-lag-loop] principal ${LAG_LOOP_AGENT} ${written ? 'written' : 'in sync'}.`,
  );
}

main().catch((err) => {
  console.error('[bootstrap-lag-loop] FAILED:', err);
  process.exit(1);
});
