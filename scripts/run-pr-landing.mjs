#!/usr/bin/env node
/**
 * The pr-landing Actor driver (Phase 53b).
 *
 * Gives the pr-landing agent a "soul": wires every framework primitive
 * through to a running actor that reads review comments from a real
 * GitHub PR, classifies them, and acts within its delegated authority.
 *
 * Composition (read this top to bottom; it IS the framework claim):
 *   1. Host              - createFileHost over .lag/ (governance boundary)
 *   2. Principal         - pr-landing-agent from host.principals
 *   3. ActorAdapter      - GhClient + GitHubPrReviewAdapter (D17 seam)
 *   4. Actor             - PrLandingActor (the mechanism)
 *   5. runActor          - enforces kill-switch, budget, convergence,
 *                          policy gate (checkToolPolicy) per-action,
 *                          audit trail through host.auditor.
 *
 * Safety rails:
 *   - Dry-run is the DEFAULT. Write operations short-circuit inside the
 *     adapter and log what they would do. Reads still run so observation
 *     + classification are exercised.
 *   - --live must be passed explicitly to enable writes.
 *   - Kill-switch checks `.lag/STOP`. Touch that file to halt.
 *   - Budget defaults to 3 iterations, 60s deadline per run.
 *
 * Usage:
 *   node scripts/run-pr-landing.mjs --pr 1                    # dry-run (default)
 *   node scripts/run-pr-landing.mjs --pr 1 --live             # posts comments
 *   node scripts/run-pr-landing.mjs --pr 1 --max-iterations 5
 *   node scripts/run-pr-landing.mjs --pr 1 --owner stephengardner --repo layered-autonomous-governance
 */

import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { createFileHost } from '../dist/adapters/file/index.js';
import { runActor } from '../dist/actors/index.js';
import { PrLandingActor } from '../dist/actors/pr-landing/index.js';
import {
  GitHubPrReviewAdapter,
  UserAccountCommentTrigger,
  getTokenFromEnv,
} from '../dist/actors/pr-review/index.js';
import { createGhClient } from '../dist/external/github/index.js';
import {
  sendOperatorEscalation,
  shouldEscalate,
  renderEscalationBody,
} from '../dist/actor-message/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');
const STOP_SENTINEL = resolve(STATE_DIR, 'STOP');

function parseArgs(argv) {
  const args = {
    prNumber: null,
    owner: null,
    repo: null,
    live: false,
    maxIterations: 3,
    deadlineMs: 60_000,
    principalId: 'pr-landing-agent',
    origin: 'github-action',
  };
  const parseInt = (raw, flag) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      console.error(`ERROR: ${flag} expects a positive integer, got "${raw}".`);
      process.exit(2);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pr') args.prNumber = parseInt(argv[++i], '--pr');
    else if (a === '--owner') args.owner = argv[++i];
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--live') args.live = true;
    else if (a === '--dry-run') args.live = false;
    else if (a === '--max-iterations') args.maxIterations = parseInt(argv[++i], '--max-iterations');
    else if (a === '--deadline-ms') args.deadlineMs = parseInt(argv[++i], '--deadline-ms');
    else if (a === '--principal') args.principalId = argv[++i];
    else if (a === '--origin') args.origin = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node scripts/run-pr-landing.mjs --pr <n> [--owner o --repo r] [--live] [--max-iterations n]',
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  // All-or-nothing pair: both or neither. Mixing one exposes the
  // caller to resolveOwnerRepo fallback behaviour they probably did
  // not intend; surface it early.
  if ((args.owner === null) !== (args.repo === null)) {
    console.error('ERROR: --owner and --repo must be provided together (or neither, for gh repo-view fallback).');
    process.exit(2);
  }
  return args;
}

async function resolveOwnerRepo(args) {
  if (args.owner && args.repo) return { owner: args.owner, repo: args.repo };
  const result = await execa('gh', ['repo', 'view', '--json', 'owner,name'], { reject: false });
  if (result.exitCode !== 0) {
    throw new Error(`Could not resolve owner/repo via gh; pass --owner and --repo explicitly. stderr: ${result.stderr}`);
  }
  const parsed = JSON.parse(result.stdout);
  return { owner: parsed.owner.login, repo: parsed.name };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.prNumber === null) {
    console.error('ERROR: --pr <number> is required.');
    process.exit(2);
  }
  const { owner, repo } = await resolveOwnerRepo(args);

  const host = await createFileHost({ rootDir: STATE_DIR });

  const principal = await host.principals.get(args.principalId);
  if (!principal) {
    console.error(
      `ERROR: principal '${args.principalId}' not found in ${STATE_DIR}. Run scripts/bootstrap-pr-landing-canon.mjs first.`,
    );
    process.exit(1);
  }

  const client = createGhClient();
  const review = new GitHubPrReviewAdapter({ client, dryRun: !args.live });
  const reviewTrigger = new UserAccountCommentTrigger({
    getToken: getTokenFromEnv('LAG_OPS_PAT'),
    dryRun: !args.live,
    actingAs: 'lag-ops',
  });

  // ensureReviewers is intentionally NOT configured for CodeRabbit
  // here. The actor's ensureReviewers mechanism posts the trigger
  // via review.postPrComment(), which uses github-actions[bot] in
  // CI; CR's anti-loop ignores [bot] comments so that post is
  // noise. The maybeTriggerCr pre-check above handles CR via the
  // machine-user PAT instead, which CR honors. The actor's
  // ensureReviewers slot remains available for reviewers that DO
  // respond to bot comments (none today); configure it per-reviewer
  // if that changes.
  const actor = new PrLandingActor({
    pr: { owner, repo, number: args.prNumber },
  });

  const deadline = new Date(Date.now() + args.deadlineMs).toISOString();
  const mode = args.live ? 'LIVE' : 'DRY-RUN';
  console.log(`[pr-landing] ${mode} run on ${owner}/${repo}#${args.prNumber} as ${args.principalId}`);
  console.log(`[pr-landing] budget: maxIterations=${args.maxIterations}, deadline=${deadline}`);

  // Pre-actor CR-failsafe trigger. If CodeRabbit has not engaged on
  // this PR AND the PR was opened by a [bot] account AND it is past
  // a short grace window for CR's own auto_review to fire, post
  // `@coderabbitai review` as the machine-user principal via the
  // ReviewTriggerAdapter. This is the mechanism that guarantees CR
  // runs on every bot-opened PR despite CR's anti-loop ignoring
  // bot comments (dev-coderabbit-required-status-check-non-negotiable
  // in canon makes the failsafe mandatory for repo merge discipline).
  // Best-effort: any failure here logs + proceeds; the actor's own
  // work is independent of whether CR triggers.
  if (args.live) {
    await maybeTriggerCr({
      client,
      review,
      reviewTrigger,
      owner,
      repo,
      number: args.prNumber,
    });
  }

  const report = await runActor(actor, {
    host,
    principal,
    adapters: { review },
    budget: { maxIterations: args.maxIterations, deadline },
    origin: args.origin,
    killSwitch: () => existsSync(STOP_SENTINEL),
    onAudit: async (event) => {
      // Tee audit events to stdout for operator visibility + to host.auditor
      // for the durable record.
      console.log(`[audit] iter=${event.iteration} kind=${event.kind} ${summarize(event.payload)}`);
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

  console.log('[pr-landing] --- REPORT ---');
  console.log(JSON.stringify(
    {
      actor: report.actor,
      principal: report.principal,
      haltReason: report.haltReason,
      iterations: report.iterations,
      startedAt: report.startedAt,
      endedAt: report.endedAt,
      escalations: report.escalations,
      lastNote: report.lastNote,
    },
    null,
    2,
  ));

  // Escalation path: if the actor halted with anything other than
  // `converged`, OR left items unhandled (policy escalations,
  // body-scoped nits the reviewer posted inside a review body rather
  // than as replyable line comments), emit an actor-message to the
  // operator so the halt does not die silently in the CI log.
  //
  // We re-observe once post-halt so the message includes the CURRENT
  // set of unresolved items — between the actor's last iteration and
  // now, some threads may have been resolved manually. Re-observation
  // is cheap (two GraphQL + REST calls, ~1s).
  try {
    let observation;
    try {
      const [comments, bodyNits] = await Promise.all([
        review.listUnresolvedComments({ owner, repo, number: args.prNumber }),
        review.listReviewBodyNits({ owner, repo, number: args.prNumber }),
      ]);
      observation = { comments, bodyNits };
    } catch (obsErr) {
      console.warn(`[pr-landing] post-halt observation failed: ${obsErr?.message ?? obsErr}`);
      observation = undefined;
    }

    if (shouldEscalate(report, observation)) {
      const escalationCtx = {
        host,
        report,
        pr: { owner, repo, number: args.prNumber },
        origin: args.origin,
        ...(observation ? { observation } : {}),
      };
      const { atomId, alreadyExisted } = await sendOperatorEscalation(escalationCtx);

      // Single if/else covers both the log line and the PR-comment
      // post. Two sequential `if (alreadyExisted)` blocks read as
      // bug-prone even when behaviorally fine; collapse for clarity.
      //
      // Dedup gate: `alreadyExisted` signals the atom write hit
      // ConflictError on the deterministic id (same actor + PR +
      // haltReason + iter). Skipping the PR comment keeps repeat runs
      // quiet. A genuinely new halt (different haltReason on the
      // same PR) yields a distinct atom id and posts fresh.
      //
      // PR-comment delivery is the CI-ephemeral-filesystem escape
      // hatch: the atom lands in the runner's .lag/ which disappears
      // at job end; the PR comment persists in the PR discussion
      // history and pings the operator via GitHub's notification
      // stack - no extra secret or daemon. Adapter's dry-run
      // short-circuits postPrComment internally, so dry-run runs log
      // the intent but do not call GitHub. Catch is best-effort per
      // the outer catch's contract: a secondary-delivery failure
      // does NOT alter the actor's exit code (the actor's own
      // outcome is what CI gates on). Warning goes to stderr
      // (console.warn) so CI log readers still see it loudly.
      if (alreadyExisted) {
        console.log(
          `[pr-landing] escalation atom ${atomId} already existed (deduped); skipping PR comment`,
        );
      } else {
        console.log(`[pr-landing] escalation written as atom ${atomId}`);
        try {
          const body = renderEscalationBody(escalationCtx);
          const outcome = await review.postPrComment(
            { owner, repo, number: args.prNumber },
            body,
          );
          if (outcome.posted) {
            console.log(
              `[pr-landing] escalation posted as PR comment ${outcome.commentId ?? '(id unknown)'}`,
            );
          } else if (outcome.dryRun) {
            console.log('[pr-landing] (dry-run) would have posted escalation as PR comment');
          }
        } catch (commentErr) {
          console.warn(
            `[pr-landing] escalation PR comment failed: ${commentErr?.message ?? commentErr}`,
          );
        }
      }
    }
  } catch (escErr) {
    // Escalation is best-effort: a failure to write the message must
    // NOT change the actor's exit code (the actor's own outcome is
    // what CI gates on). Log and continue.
    console.warn(`[pr-landing] escalation write failed: ${escErr?.message ?? escErr}`);
  }

  // Exit code signals the broad outcome so CI can gate on it.
  //   0 = actor operated correctly (converged OR escalated by design)
  //   1 = actor crashed (genuine error)
  //   2 = budget exhausted; another run may be needed
  //
  // Why every "correct halt" -> 0: policy-escalate-blocking and
  // convergence-loop are both VALID outcomes per the autonomy-dial
  // design. The actor did its job and surfaced items for the
  // operator via the actor-message escalation written above (see
  // sendOperatorEscalation). Marking those as CI failures would
  // double-signal the operator (red CI + inbox notification) AND
  // block PRs on their own agent's correct escalation - exactly the
  // opposite of what we want. budget-iterations / budget-deadline
  // stay at 2 because those ARE "run me again with more budget"
  // signals, not "I know what I saw, deal with it" signals.
  const exitMap = {
    'converged': 0,
    'policy-escalate-blocking': 0,
    'kill-switch': 0,
    'convergence-loop': 0,
    'budget-iterations': 2,
    'budget-deadline': 2,
    'error': 1,
  };
  process.exit(exitMap[report.haltReason] ?? 1);
}

/**
 * CR-failsafe pre-check. Decides whether to POST `@coderabbitai
 * review` as the machine-user principal BEFORE the actor runs.
 *
 * Guard conditions (all must hold to trigger):
 *   - PR's author is a `[bot]` account. Human-authored PRs get
 *     CR's native auto_review; no failsafe needed there.
 *   - CR has NOT already engaged (no prior CR review/comment
 *     visible). Polled via the review adapter's
 *     hasReviewerEngaged, which checks both review + issue
 *     comment surfaces.
 *   - PR is past the grace window: CR's own auto_review typically
 *     runs within a minute of open; we wait 2 minutes before
 *     stepping in so we do not race CR's own happy path.
 *
 * Best-effort: any error reading PR state or token is logged and
 * the actor proceeds. The actor does meaningful work independently
 * of whether CR is engaged; the failsafe is additive, not
 * required.
 */
async function maybeTriggerCr({ client, review, reviewTrigger, owner, repo, number }) {
  const GRACE_WINDOW_MS = 2 * 60_000;
  try {
    const prInfo = await client.rest({ path: `repos/${owner}/${repo}/pulls/${number}` });
    if (!prInfo) {
      console.warn('[cr-failsafe] could not read PR info; skipping');
      return;
    }
    const author = prInfo.user?.login ?? '';
    const authorIsBot = author.endsWith('[bot]') || prInfo.user?.type === 'Bot';
    if (!authorIsBot) {
      console.log(`[cr-failsafe] PR author '${author}' is not a bot; skipping failsafe (CR's auto_review covers this)`);
      return;
    }
    const createdAt = new Date(prInfo.created_at).getTime();
    const ageMs = Date.now() - createdAt;
    if (ageMs < GRACE_WINDOW_MS) {
      const leftS = Math.ceil((GRACE_WINDOW_MS - ageMs) / 1000);
      console.log(`[cr-failsafe] PR is within grace window (${leftS}s left); deferring to CR auto_review`);
      return;
    }
    const engaged = await review.hasReviewerEngaged(
      { owner, repo, number },
      ['coderabbitai[bot]', 'coderabbitai'],
    );
    if (engaged) {
      console.log('[cr-failsafe] CR already engaged; no trigger needed');
      return;
    }
    // Idempotency guard: if a prior pr-landing run already posted
    // the machine-user trigger on this PR (e.g., CR is delayed and
    // a later pr-landing event fires), do NOT post again. Without
    // this, multiple runs against the same PR before CR responds
    // would stack comments. The login is deployment-specific so
    // it is read from env with a sensible default; callers override
    // via LAG_OPS_LOGIN for their own machine user.
    const triggerLogin = process.env.LAG_OPS_LOGIN ?? 'layered-autonomous-governance';
    const alreadyTriggered = await review.hasReviewerEngaged(
      { owner, repo, number },
      [triggerLogin],
    );
    if (alreadyTriggered) {
      console.log(`[cr-failsafe] machine-user (${triggerLogin}) already posted trigger; waiting for CR engagement`);
      return;
    }
    console.log(
      `[cr-failsafe] bot-authored PR #${number} past grace window with no CR engagement; posting trigger as ${triggerLogin}`,
    );
    const outcome = await reviewTrigger.triggerReview(
      { owner, repo, number },
      '@coderabbitai review',
    );
    if (outcome.posted) {
      console.log(`[cr-failsafe] trigger posted as comment ${outcome.commentId ?? '(id unknown)'}`);
    } else if (outcome.dryRun) {
      console.log('[cr-failsafe] (dry-run) would have posted CR trigger');
    } else {
      console.warn(`[cr-failsafe] trigger NOT posted: ${outcome.failure ?? 'unknown'}`);
    }
  } catch (err) {
    console.warn(`[cr-failsafe] pre-check failed: ${err?.message ?? err}`);
  }
}

function summarize(payload) {
  if (!payload) return '';
  const keys = Object.keys(payload);
  if (keys.length === 0) return '';
  const compact = {};
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === 'string') compact[k] = v.length > 60 ? v.slice(0, 60) + '...' : v;
    else if (typeof v === 'number' || typeof v === 'boolean') compact[k] = v;
    else if (Array.isArray(v)) compact[k] = `[${v.length}]`;
    else compact[k] = typeof v;
  }
  return JSON.stringify(compact);
}

main().catch((err) => {
  console.error('[pr-landing] FAILED:', err);
  process.exit(1);
});
