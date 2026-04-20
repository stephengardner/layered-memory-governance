#!/usr/bin/env node
/**
 * cto-actor driver (Phase 55b).
 *
 * Invokes the PlanningActor under the cto-actor Principal against an
 * operator request, producing Plan atoms + HIL escalations.
 *
 * Usage:
 *   node scripts/run-cto-actor.mjs --request "Should we split 53a.1 into a separate package?"
 *   node scripts/run-cto-actor.mjs --request "..." --dry-run   # don't write atoms; print plans
 *
 * The script composes LAG primitives explicitly so it reads as a
 * worked example of the full stack:
 *
 *   Host (createFileHost)
 *     -> Principal (cto-actor from host.principals)
 *        -> Actor (PlanningActor)
 *           -> Judgment (stub for 55b; real LLM lands in a follow-up)
 *              -> runActor driver (checkToolPolicy gate, audit, budget)
 *                 -> atoms.put(planAtom) + notifier.telegraph(escalation)
 *
 * The stub judgment in this driver returns a deterministic "needs
 * research" plan so the full pipeline is runnable end-to-end without
 * a Claude CLI call. Replace with HostLlmPlanningJudgment (future
 * phase) to get real plan drafting.
 */

import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';
import { runActor } from '../dist/actors/index.js';
import { PlanningActor } from '../dist/actors/planning/index.js';

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
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--request' && i + 1 < argv.length) args.request = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--max-iterations' && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) {
        console.error('ERROR: --max-iterations expects a positive integer');
        process.exit(2);
      }
      args.maxIterations = n;
    } else if (a === '--principal' && i + 1 < argv.length) args.principalId = argv[++i];
    else if (a === '--origin' && i + 1 < argv.length) args.origin = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node scripts/run-cto-actor.mjs --request "<text>" [--dry-run] [--max-iterations n]');
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

  const host = await createFileHost({ rootDir: STATE_DIR });

  const principal = await host.principals.get(args.principalId);
  if (!principal) {
    console.error(
      `ERROR: principal '${args.principalId}' not found. Run scripts/bootstrap-cto-actor-canon.mjs first.`,
    );
    process.exit(1);
  }

  const actor = new PlanningActor({
    request: args.request,
    judgment: stubJudgment(),
  });

  const deadline = new Date(Date.now() + 60_000).toISOString();
  console.log(`[cto-actor] LIVE run as ${args.principalId}`);
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
