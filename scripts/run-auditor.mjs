#!/usr/bin/env node
/**
 * run-auditor: invoked from pr-landing workflow when a PR carries a
 * plan-id: <id> label. Fetches PR diff, classifies blast radius,
 * compares to intent envelope, writes:
 *   1. An observation atom (kind: 'auditor-plan-check') with the verdict.
 *   2. A GitHub Commit Status under context 'LAG-auditor' with state
 *      'success' (verdict=pass) or 'failure' (verdict=fail).
 *
 * Usage:
 *   node scripts/run-auditor.mjs --pr <number> --plan <plan-id>
 *
 * Exit codes:
 *   0 - verdict pass (status posted, atom written)
 *   1 - verdict fail (status posted, atom written)
 *   2 - invocation error (args, env, missing atom)
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { createFileHost } from '../dist/adapters/file/index.js';
import { classifyDiffBlastRadius, computeVerdict } from './lib/auditor.mjs';
import {
  PLAN_ID_LABEL_PREFIX,
  parseEmbeddedAtomFromPrBody,
  parsePlanIdFromPrBody,
  truncatePlanIdLabel,
} from './lib/autonomous-dispatch-exec.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');
const REPO = process.env.GH_REPO ?? 'stephengardner/layered-autonomous-governance';

function parseArgs(argv) {
  const a = { pr: null, plan: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pr' && i + 1 < argv.length) a.pr = argv[++i];
    else if (argv[i] === '--plan' && i + 1 < argv.length) a.plan = argv[++i];
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pr || !args.plan) {
    console.error('[auditor] usage: --pr <number> --plan <plan-id>');
    process.exit(2);
  }
  const host = await createFileHost({ rootDir: STATE_DIR });
  // Read the PR body once: both fallback paths (label-truncation
  // -> footer plan-id, on-disk-miss -> embedded atom JSON) anchor
  // to it. Caching here avoids two `gh pr view` round-trips on the
  // CI-runner code path that exercises both fallbacks back-to-back.
  // A failure to read the body short-circuits at this point with a
  // clear error rather than masquerading as a "plan not found"
  // diagnostic three branches deeper. The PR-body read is idempotent;
  // a transient gh failure here means transient gh failures elsewhere
  // too, and the early surfacing keeps the error legible.
  const prBody = await readPrBody(args.pr);

  // The `--plan` argv comes from the workflow's `split(":")[1]` of
  // the `plan-id:<id>` label. When the original plan id exceeds
  // GitHub's 50-char label limit, autonomous-dispatch.mjs writes a
  // truncated label of the form `plan-id:<head>-<sha-12>` and the
  // direct atom lookup fails. The PR body's machine-parseable
  // provenance footer carries the full plan id verbatim; fall back
  // to that as the canonical source. The label is the workflow
  // trigger marker, the body footer is the carrier.
  let resolvedPlanId = args.plan;
  let plan = await host.atoms.get(resolvedPlanId);
  if (!plan || plan.type !== 'plan') {
    const fromBody = parsePlanIdFromPrBody(prBody);
    // Round-trip guard: only accept the body-derived plan id if its
    // truncatePlanIdLabel form matches the workflow-supplied label
    // token (`args.plan`). Without this gate, a malicious PR-body
    // edit could redirect the auditor at an unrelated plan whose
    // envelope happens to permit the diff. Symmetric with how the
    // dispatch-side label was minted from the plan id, so a body
    // value that did not originate from the same plan cannot pass.
    if (fromBody && fromBody !== resolvedPlanId) {
      const expectedToken = truncatePlanIdLabel(fromBody).slice(PLAN_ID_LABEL_PREFIX.length);
      if (expectedToken !== args.plan) {
        console.error(
          `[auditor] PR body plan_id does not round-trip to the triggering label token; `
          + `label=${args.plan} body=${fromBody} expected-from-body=${expectedToken}. `
          + 'Refusing the fallback to avoid auditing the wrong plan.',
        );
        process.exit(2);
      }
      console.log(`[auditor] label-derived plan id ${resolvedPlanId} did not resolve; using PR body footer plan id ${fromBody}`);
      resolvedPlanId = fromBody;
      plan = await host.atoms.get(resolvedPlanId);
    }
  }
  // Final fallback: the on-disk atom store does not have the plan
  // (CI-runner scenario where .lag/atoms/ is git-ignored, local-
  // only). The embedded-atom carrier in the PR body is the
  // substrate-pure fallback per dec-atomstore-via-api: every
  // consumer that cannot reach the live atom store gets the
  // governance state from the carrier the dispatch flow signed
  // into the PR. parseEmbeddedAtomFromPrBody validates the
  // round-trip integrity (the parsed payload's `id` must equal
  // the lookup id), which combined with the
  // truncatePlanIdLabel(fromBody) check above means a malicious
  // body cannot redirect the auditor at the wrong plan.
  if (!plan || plan.type !== 'plan') {
    const embeddedPlan = parseEmbeddedAtomFromPrBody(prBody, resolvedPlanId);
    if (embeddedPlan && embeddedPlan.type === 'plan') {
      console.log(`[auditor] plan atom ${resolvedPlanId} not on disk; resolved from PR body embedded snapshot`);
      plan = embeddedPlan;
    }
  }
  if (!plan || plan.type !== 'plan') {
    console.error(`[auditor] plan atom ${resolvedPlanId} not found or wrong type`);
    process.exit(2);
  }
  // Re-bind args.plan so the rest of the script uses the resolved
  // id verbatim (verdict atom id, derived_from chain, log lines).
  args.plan = resolvedPlanId;
  const derivedFrom = plan.provenance?.derived_from ?? [];
  let intentId = null;
  let intent = null;
  for (const refId of derivedFrom) {
    const candidate = await host.atoms.get(refId);
    if (candidate && candidate.type === 'operator-intent') {
      intentId = refId;
      intent = candidate;
      break;
    }
    // CI-runner fallback: same embedded-atom carrier the plan
    // falls back to. Walking each derived_from id symmetrically
    // means every atom the auditor reads can come from either disk
    // or carrier, and the audit chain stays intact.
    const embedded = parseEmbeddedAtomFromPrBody(prBody, refId);
    if (embedded && embedded.type === 'operator-intent') {
      intentId = refId;
      intent = embedded;
      console.log(`[auditor] operator-intent atom ${refId} not on disk; resolved from PR body embedded snapshot`);
      break;
    }
  }
  if (!intentId || !intent) {
    console.error('[auditor] plan has no operator-intent atom in provenance; auditor gate only applies to intent-driven plans');
    process.exit(2);
  }
  const envelopeMax = intent?.metadata?.trust_envelope?.max_blast_radius;
  if (!envelopeMax) {
    console.error('[auditor] intent missing trust_envelope.max_blast_radius');
    process.exit(2);
  }

  const { stdout } = await execa('gh', ['pr', 'view', args.pr, '--json', 'files', '--jq', '.files[].path']);
  const files = stdout.trim().split('\n').filter(Boolean);
  const diffRadius = classifyDiffBlastRadius(files);
  const { verdict, reason } = computeVerdict({ diffRadius, envelopeMax });
  console.log(`[auditor] plan=${args.plan} pr=${args.pr} diffRadius=${diffRadius} envelope=${envelopeMax} -> ${verdict}`);

  const nowIso = new Date().toISOString();
  const verdictAtom = {
    schema_version: 1,
    id: `auditor-plan-check-${args.plan}-${nowIso.replace(/[:.]/g, '-')}`,
    type: 'observation',
    layer: 'L1',
    principal_id: 'auditor-actor',
    provenance: {
      kind: 'agent-observed',
      source: { tool: 'run-auditor', agent_id: 'auditor-actor' },
      derived_from: [args.plan, intentId],
    },
    confidence: 1,
    scope: 'project',
    content: `Auditor verdict=${verdict}. ${reason}. diffRadius=${diffRadius} envelopeMax=${envelopeMax}.`,
    metadata: {
      kind: 'auditor-plan-check',
      verdict,
      reason,
      diff_files: files,
      diff_radius: diffRadius,
      envelope_max: envelopeMax,
      pr_number: Number(args.pr),
      plan_id: args.plan,
      intent_id: intentId,
    },
    created_at: nowIso,
    last_reinforced_at: nowIso,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    taint: 'clean',
    signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
  };
  await host.atoms.put(verdictAtom);

  const { stdout: headSha } = await execa('gh', ['pr', 'view', args.pr, '--json', 'headRefOid', '--jq', '.headRefOid']);
  const sha = headSha.trim();
  const state = verdict === 'pass' ? 'success' : 'failure';
  await execa('gh', [
    'api', `repos/${REPO}/statuses/${sha}`,
    '-f', `state=${state}`,
    '-f', `context=LAG-auditor`,
    '-f', `description=${reason.slice(0, 140)}`,
  ]);
  console.log(`[auditor] LAG-auditor status posted: ${state}`);

  process.exit(verdict === 'pass' ? 0 : 1);
}

/**
 * Read the PR body via `gh pr view`. Returns the body text on
 * success; rethrows with context on `gh` failures (auth / network
 * / API errors). Collapsing failures into an empty string would
 * make a transient GitHub outage look like a body with no
 * machine-parseable footer and silently disable the
 * truncated-label fallback + embedded-atom carrier paths; the
 * caller should see the underlying error instead. The auditor's
 * outer main().catch surfaces the rethrown error and exits
 * non-zero so CI flags the failure rather than emitting a
 * misleading "plan not found".
 *
 * Two consumers depend on this body string: parsePlanIdFromPrBody
 * (the YAML footer fallback when the workflow-supplied label was
 * truncated past GitHub's 50-char limit) and
 * parseEmbeddedAtomFromPrBody (the embedded-atom JSON snapshot
 * carrier the LAG-auditor relies on when running on a GitHub
 * Actions runner with no .lag/atoms/ directory and no named
 * tunnel back to the operator's API surface).
 */
async function readPrBody(prNumber) {
  let stdout;
  try {
    ({ stdout } = await execa('gh', ['pr', 'view', String(prNumber), '--json', 'body', '--jq', '.body']));
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`[auditor] failed to read PR #${prNumber} body: ${cause}`);
  }
  return stdout ?? '';
}

main().catch((err) => {
  console.error(`[auditor] ${err.message}`);
  process.exit(2);
});
