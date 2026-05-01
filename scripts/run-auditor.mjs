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
import {
  classifyDiffBlastRadius,
  computeVerdict,
  isPrAuthorTrustedForEmbedded,
} from './lib/auditor.mjs';
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
  // Read the PR body and author once: both fallback paths
  // (label-truncation -> footer plan-id, on-disk-miss -> embedded
  // atom JSON) anchor to the body, and the embedded-snapshot
  // fallback gates on the PR's authoring identity. Caching here
  // avoids two `gh pr view` round-trips on the CI-runner code
  // path that exercises both fallbacks back-to-back. A failure
  // to read short-circuits at this point with a clear error
  // rather than masquerading as a "plan not found" diagnostic
  // three branches deeper. The PR-view read is idempotent; a
  // transient gh failure here means transient gh failures
  // elsewhere too, and the early surfacing keeps the error
  // legible.
  const { body: prBody, authorLogin: prAuthorLogin } = await readPrSnapshot(args.pr);

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
  // into the PR.
  //
  // SECURITY: trusting embedded JSON requires more than the
  // round-trip id check (`parsed.id === atomId`) the parser
  // performs. A PR editor who keeps the id but rewrites
  // `trust_envelope`, provenance, or plan content could pass
  // that gate and ship a forged atom. The dispatch flow opens
  // these PRs as a configured bot identity (via
  // LAG_DISPATCH_BOT_ROLE / LAG_AUDITOR_TRUSTED_PR_AUTHOR);
  // gating the embedded-snapshot path on the PR's actual
  // authoring login raises the editor bar from "anyone with PR
  // edit access" to "the dispatch bot or a repo admin". This
  // matches the bot-identity discipline canon already enforces
  // for every other governance-visible action and is the
  // strongest authorial check available before atom-level
  // signing lands. A future hardening pass replaces this with a
  // per-atom signature the dispatch flow attaches at PR-creation
  // time (canon `Every atom must carry provenance with a source
  // chain` is the lineage hook); until then, fail-closed when
  // the PR author does not match.
  if (!plan || plan.type !== 'plan') {
    if (!isPrAuthorTrustedForEmbedded(prAuthorLogin, process.env.LAG_AUDITOR_TRUSTED_PR_AUTHOR)) {
      console.error(
        `[auditor] plan atom ${resolvedPlanId} not on disk and PR author `
        + `'${prAuthorLogin ?? '(unknown)'}' is not in the trusted-author allowlist `
        + '(LAG_AUDITOR_TRUSTED_PR_AUTHOR). Refusing to read embedded snapshots from '
        + 'an untrusted PR author to prevent body-edit tampering.',
      );
      process.exit(2);
    }
    const embeddedPlan = parseEmbeddedAtomFromPrBody(prBody, resolvedPlanId);
    if (embeddedPlan && embeddedPlan.type === 'plan') {
      console.log(`[auditor] plan atom ${resolvedPlanId} not on disk; resolved from PR body embedded snapshot (PR author '${prAuthorLogin}' is trusted)`);
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
  // The intent fallback inherits the same authorial gate the
  // plan fallback applies: an embedded operator-intent payload
  // is trusted only when the PR author is in the trusted-author
  // allowlist. Compute the authorisation once before the loop so
  // the per-id check is a cheap boolean.
  const authorTrusted = isPrAuthorTrustedForEmbedded(prAuthorLogin, process.env.LAG_AUDITOR_TRUSTED_PR_AUTHOR);
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
    // or carrier, and the audit chain stays intact. SECURITY:
    // gated on the PR-author allowlist for the same reason the
    // plan fallback is (see authorial-gate comment above).
    if (!authorTrusted) continue;
    const embedded = parseEmbeddedAtomFromPrBody(prBody, refId);
    if (embedded && embedded.type === 'operator-intent') {
      intentId = refId;
      intent = embedded;
      console.log(`[auditor] operator-intent atom ${refId} not on disk; resolved from PR body embedded snapshot (PR author '${prAuthorLogin}' is trusted)`);
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
 * Read the PR body + author login via a single `gh pr view`.
 * Returns `{body, authorLogin}` on success; rethrows with
 * context on `gh` failures (auth / network / API errors).
 * Collapsing failures into empty values would make a transient
 * GitHub outage look like a body with no machine-parseable
 * footer and silently disable the truncated-label fallback +
 * embedded-atom carrier paths; the caller should see the
 * underlying error instead. The auditor's outer main().catch
 * surfaces the rethrown error and exits non-zero so CI flags
 * the failure rather than emitting a misleading "plan not
 * found".
 *
 * Three consumers depend on this snapshot:
 *   - parsePlanIdFromPrBody (YAML footer fallback when the
 *     workflow-supplied label was truncated past GitHub's
 *     50-char limit)
 *   - parseEmbeddedAtomFromPrBody (embedded JSON carrier the
 *     LAG-auditor relies on when the runner has no .lag/atoms/)
 *   - isPrAuthorTrustedForEmbedded (authorial gate the embedded
 *     fallback path uses to refuse body-edit tampering on PRs
 *     opened by an untrusted identity)
 *
 * The `--jq` filter assembles a JSON-line carrying both fields
 * so the parse stays single-source. Returns the body as the
 * empty string on a missing-body PR (rare; gh returns the
 * literal string "null" or an empty stdout for unset fields)
 * so downstream parsers behave consistently.
 */
async function readPrSnapshot(prNumber) {
  let stdout;
  try {
    ({ stdout } = await execa('gh', ['pr', 'view', String(prNumber), '--json', 'body,author', '--jq', '{body: .body, authorLogin: .author.login}']));
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`[auditor] failed to read PR #${prNumber} body+author: ${cause}`);
  }
  if (!stdout || stdout.trim().length === 0) {
    return { body: '', authorLogin: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`[auditor] failed to parse PR #${prNumber} snapshot JSON: ${cause}`);
  }
  return {
    body: typeof parsed.body === 'string' ? parsed.body : '',
    authorLogin: typeof parsed.authorLogin === 'string' ? parsed.authorLogin : null,
  };
}


main().catch((err) => {
  console.error(`[auditor] ${err.message}`);
  process.exit(2);
});
