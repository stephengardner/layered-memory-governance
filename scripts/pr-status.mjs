#!/usr/bin/env node
/**
 * pr-status: canonical multi-surface read of a GitHub PR's review state.
 *
 * Existence rationale: session agents kept making decisions on partial
 * observations (e.g., polling one status API and missing that CodeRabbit
 * had completed a review on a different surface). See canon directive
 * `dev-multi-surface-review-observation` for the belief layer, and
 * `arch-pr-state-observation-via-actor-only` for the long-term shape.
 * This CLI is the short-term mechanism: one command, one output shape,
 * every surface covered, no way to accidentally read a subset.
 *
 * Wraps `PrReviewAdapter.getPrReviewStatus(pr)` (the composite read
 * shipped alongside this script) and pretty-prints the snapshot so the
 * operator and the agent see the same thing. The PreToolUse hook
 * `.claude/hooks/enforce-pr-status-composite.mjs` blocks ad-hoc
 * `gh pr view` / `gh api .../pulls/...` state reads and redirects here,
 * so the agent's tool surface forces composite reads by default.
 *
 * Usage:
 *   node scripts/pr-status.mjs <pr-number> [--owner owner] [--repo repo]
 *   node scripts/pr-status.mjs 52
 *
 * Resolves owner/repo via `gh repo view` if not passed, matching the
 * run-pr-landing.mjs convention.
 *
 * Output: human-readable text. Stdout only; stderr is reserved for
 * wrapper diagnostics (token mint, operator-action atom log from
 * gh-as.mjs, etc.) so piping into `| grep` or `| less` works cleanly.
 *
 * Design note (long-term direction):
 *   The sanctioned long-term shape per
 *   `arch-pr-state-observation-via-actor-only` is that the pr-landing
 *   actor IS the PR observer: session agents do not poll state
 *   directly, they consume the actor's output (escalation actor-message
 *   atom + PR comment via Gap 1). This script is a stepping stone:
 *   it uses the same composite read the actor uses, but invokes it
 *   directly from the session instead of through the actor loop. A
 *   follow-up will add `run-pr-landing.mjs --observe-only` which runs
 *   the actor's observation step + writes the atom (audit trail) +
 *   returns the atom id. This script will then become a thin wrapper
 *   around that invocation, keeping the operator's "show me state"
 *   ergonomic unchanged while routing every observation through the
 *   actor + atom trail.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { GitHubPrReviewAdapter } from '../dist/actors/pr-review/index.js';
import { createGhClient } from '../dist/external/github/index.js';
import { createFileHost } from '../dist/adapters/file/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');

// Freshness threshold: if the newest pr-observation atom for this PR is
// older than this, we still render it (with an age banner) but ALSO
// refresh from the live API. Tuned toward "show something immediately
// but warn if stale"; 2 minutes matches the CR failsafe grace window.
const OBSERVATION_FRESH_MS = 2 * 60_000;

function parseArgs(argv) {
  const args = { prNumber: null, owner: null, repo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--owner') args.owner = argv[++i];
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/pr-status.mjs <pr-number> [--owner o --repo r]');
      process.exit(0);
    } else if (a.startsWith('--')) {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    } else if (args.prNumber === null) {
      const n = Number(a);
      if (!Number.isInteger(n) || n < 1) {
        console.error(`ERROR: pr-number must be a positive integer, got "${a}".`);
        process.exit(2);
      }
      args.prNumber = n;
    } else {
      console.error(`Unexpected positional argument: ${a}`);
      process.exit(2);
    }
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

/**
 * Render a single CheckRun / status line. Uniform format across the
 * two legacy vs check-runs surfaces so an operator reading the output
 * does not have to mentally map state names.
 */
function renderCheck(name, status, conclusion) {
  const s = conclusion ?? status ?? '?';
  return `  - ${name.padEnd(40)} ${s}`;
}

function renderReview(r) {
  const ts = r.submittedAt || '?';
  const body = r.body ? ` — ${r.body.slice(0, 80).replace(/\n/g, ' ')}` : '';
  return `  - ${r.author.padEnd(32)} ${r.state.padEnd(20)} ${ts}${body}`;
}

function renderComment(c) {
  const loc = c.path
    ? `${c.path}${c.line !== undefined ? ':' + c.line : ''}`
    : `comment ${c.id}`;
  const head = c.body.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '(empty)';
  const stripped = head.replace(/^\*\*/, '').replace(/\*\*$/, '');
  return `  - ${loc.padEnd(48)} ${c.author.padEnd(20)} ${stripped.slice(0, 80)}`;
}

/**
 * Deterministic CodeRabbit verdict.
 *
 * Background: when CR reviews a PR and finds no issues, it posts a
 * summary issue-comment containing "No actionable comments were
 * generated in the recent review." — NOT a GitHub Review object
 * (so `status.submittedReviews` doesn't surface it) and NOT always
 * a legacy `CodeRabbit` status context either (CR's status-posting
 * has been observed to no-op on small diffs, breaking the
 * branch-protection gate even though CR did sign off). Before this
 * helper existed, `unresolved line comments (0)` was the only
 * visible signal, and that state is identical to "CR hasn't
 * reviewed yet", so agents could not deterministically tell
 * "approved, merge" apart from "still waiting".
 *
 * This helper reads the PR's issue-level comments (where CR posts
 * its summary) and the legacy `CodeRabbit` status context, and
 * returns a single string verdict:
 *
 *   approved    - CR posted the "No actionable comments" summary
 *                 (verdict detail includes the comment timestamp).
 *   has-findings- CR posted "Actionable comments posted: N" with N>0
 *                 (detail includes N).
 *   pending     - CR acknowledged a trigger ("Review triggered.")
 *                 but hasn't posted a verdict yet.
 *   success     - legacy CodeRabbit status is success (fallback).
 *   failure     - legacy CodeRabbit status is failure.
 *   missing     - no CR comments AND no legacy status; PR has not
 *                 been reviewed. Agents MUST trigger a review.
 *
 * Precedence: issue-comment parse wins over legacy-status fallback
 * because the comment carries richer information (exact finding
 * count) and the legacy status has been observed unreliable. Most-
 * recent comment wins within the comment path.
 */
/**
 * Fetch the committer date of the PR's current head commit. Used
 * to filter out CR comments from previous heads in the verdict
 * parse - without this, a stale `No actionable comments` summary
 * from the PRE-force-push head could be returned as the verdict
 * for the NEW head, masking a pending real review. Returns null
 * on any failure (verdict parser will then consider all comments;
 * legacy behaviour).
 */
async function readHeadCommitTimestamp(client, pr) {
  try {
    const prMeta = await client.rest({
      path: `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
    });
    const sha = prMeta?.head?.sha;
    if (typeof sha !== 'string' || sha.length === 0) return null;
    const commit = await client.rest({
      path: `repos/${pr.owner}/${pr.repo}/commits/${sha}`,
    });
    const iso = commit?.commit?.committer?.date ?? commit?.commit?.author?.date ?? null;
    return typeof iso === 'string' ? iso : null;
  } catch {
    return null;
  }
}

async function readCodeRabbitVerdict(client, pr, status, headSinceIso) {
  const commentVerdict = await tryIssueCommentVerdict(client, pr, headSinceIso);
  // CR posts its summary EITHER as an issue comment (small diffs, no
  // findings -> "🎉 No actionable comments...") OR as a PR review
  // body (larger diffs, with findings -> "Actionable comments
  // posted: N"). Consult both; most-recent wins.
  const reviewVerdict = classifyCrReviews(status.submittedReviews ?? [], headSinceIso);
  const bestCommentPath = pickNewer(commentVerdict, reviewVerdict);
  const legacyCr = (status.legacyStatuses ?? []).find(
    (s) => s.context === 'CodeRabbit',
  );
  // Definitive comment verdicts beat everything: the summary comment
  // is CR's richest signal (exact finding count, explicit approval
  // phrase).
  if (bestCommentPath && bestCommentPath.verdict !== 'pending') {
    return bestCommentPath;
  }
  // Neither a definitive comment verdict nor trigger-ACK: use the
  // legacy status if present. On many small-diff PRs CR emits the
  // legacy `CodeRabbit` status without posting a summary comment,
  // so this fallback is how the gate actually converges.
  if (legacyCr) {
    return {
      verdict: legacyCr.state === 'success' ? 'success' : legacyCr.state,
      detail: bestCommentPath?.verdict === 'pending'
        ? 'legacy status present; CR summary comment not yet emitted'
        : null,
    };
  }
  // Only trigger-ACKs / pending from either surface, no legacy
  // status: CR has seen the PR but has not produced a verdict on
  // this head yet.
  if (bestCommentPath && bestCommentPath.verdict === 'pending') {
    return bestCommentPath;
  }
  return { verdict: 'missing', detail: null };
}

/**
 * Newer-wins between the issue-comment verdict and the review-body
 * verdict. Both share the same shape (verdict + detail, with the
 * trailing timestamp encoded in `detail`). When only one path
 * produced a signal, that one wins.
 */
function pickNewer(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  // Extract trailing ISO timestamps from detail for comparison.
  const ta = (a.detail ?? '').match(/\d{4}-\d{2}-\d{2}T[\d:]+Z/)?.[0] ?? '';
  const tb = (b.detail ?? '').match(/\d{4}-\d{2}-\d{2}T[\d:]+Z/)?.[0] ?? '';
  return ta >= tb ? a : b;
}

/**
 * Parse CR review bodies for the `Actionable comments posted: N`
 * summary. CR emits this on reviews where it had findings (or
 * explicitly zero). Filters to the current head via the same
 * head-commit-timestamp gate the issue-comment path uses.
 */
function classifyCrReviews(submittedReviews, headSinceIso) {
  const crReviews = submittedReviews
    .filter((r) => r && r.author === 'coderabbitai[bot]')
    .filter((r) => !headSinceIso || String(r.submittedAt) >= headSinceIso)
    .slice()
    .sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
  for (const r of crReviews) {
    const body = String(r.body ?? '');
    if (/No actionable comments were generated/i.test(body)) {
      return { verdict: 'approved', detail: `via review at ${r.submittedAt}` };
    }
    const m = body.match(/Actionable comments? posted:\s*(\d+)/i);
    if (m) {
      const n = Number(m[1]);
      if (n === 0) {
        return { verdict: 'approved', detail: `via review at ${r.submittedAt}` };
      }
      return { verdict: 'has-findings', detail: `${n} actionable @ ${r.submittedAt}` };
    }
  }
  return null;
}

async function tryIssueCommentVerdict(client, pr, headSinceIso) {
  try {
    // Paginate with per_page=100. The REST default is 30, and on a
    // long-running PR with many review cycles the verdict summary
    // can fall outside the first page - producing a false 'missing'
    // that triggers a redundant @coderabbitai review nudge. Mirrors
    // the pagination pattern /pulls/{n}/reviews already uses.
    const crComments = [];
    let page = 1;
    for (;;) {
      const batch = await client.rest({
        path: `repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`,
        query: { per_page: 100, page },
      });
      if (!Array.isArray(batch)) break;
      for (const c of batch) {
        if (!c || !c.user || c.user.login !== 'coderabbitai[bot]') continue;
        // Bind the verdict to the CURRENT head: a summary from an
        // older head is not a verdict on the new one. `headSinceIso`
        // is the head commit's committer date; older comments are
        // skipped. When absent (caller opted out), every comment is
        // considered (preserves prior behaviour for any consumer
        // that cannot resolve a head timestamp).
        if (headSinceIso && String(c.created_at) < headSinceIso) continue;
        crComments.push(c);
      }
      if (batch.length < 100) break;
      page += 1;
      if (page > 10) break; // hard cap; >1000 issue comments on one PR is pathological
    }
    if (crComments.length === 0) return null;

    crComments.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

    // Newest-first classify-per-comment. Return the FIRST recognized
    // state — a newer `Review triggered.` ACK beats an older
    // `No actionable comments` summary, which is correct: the
    // summary was for the PREVIOUS head and CR is actively re-
    // scanning the new one. Without this ordering, the tool could
    // report `approved` while CR is genuinely pending.
    for (const c of crComments) {
      const body = String(c.body ?? '');
      if (/No actionable comments were generated/i.test(body)) {
        return { verdict: 'approved', detail: `via comment at ${c.created_at}` };
      }
      const m = body.match(/Actionable comments? posted:\s*(\d+)/i);
      if (m) {
        const n = Number(m[1]);
        if (n === 0) {
          return { verdict: 'approved', detail: `via comment at ${c.created_at}` };
        }
        return { verdict: 'has-findings', detail: `${n} actionable @ ${c.created_at}` };
      }
      if (/Review triggered/i.test(body)) {
        return { verdict: 'pending', detail: `trigger-ACK at ${c.created_at}` };
      }
      // Other CR comments (walkthrough, replies, etc.) - keep
      // scanning for a recognized signal.
    }
    return null;
  } catch {
    // Fail-soft: a network blip on the issue-comments fetch must
    // not break the primary composite-read output.
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.prNumber === null) {
    console.error('ERROR: pr-number is required (first positional argument).');
    process.exit(2);
  }
  const { owner, repo } = await resolveOwnerRepo(args);
  const pr = { owner, repo, number: args.prNumber };

  // Atom-first projection path (per arch-pr-state-observation-via-actor-only).
  // If a recent pr-observation atom exists for this PR, render from it
  // and note the age. Fall back to live API read when:
  //   - no atom exists yet (first time observing this PR), OR
  //   - the atom is older than the freshness threshold (stale).
  // On fallback, emit a one-line warning to stderr so the operator
  // sees the degrade.
  const atomHit = await readLatestPrObservation({ owner, repo, number: pr.number });
  if (atomHit && atomHit.ageMs < OBSERVATION_FRESH_MS) {
    renderFromAtom(atomHit, pr);
    decideExitCode(atomHit.status);
    return;
  }
  if (atomHit && atomHit.ageMs >= OBSERVATION_FRESH_MS) {
    process.stderr.write(
      `[pr-status] latest pr-observation atom is ${Math.round(atomHit.ageMs / 1000)}s old; refreshing from live API\n`,
    );
  }

  const client = createGhClient();
  const adapter = new GitHubPrReviewAdapter({ client });

  const status = await adapter.getPrReviewStatus(pr);
  const headSinceIso = await readHeadCommitTimestamp(client, pr);
  const crVerdict = await readCodeRabbitVerdict(client, pr, status, headSinceIso);

  // Header section: the single-line "at a glance" operators want to
  // see first, then every surface below it. Always render every
  // section (even when empty) so the absence of data is distinguishable
  // from the absence of the section in the output.
  console.log(`PR ${owner}/${repo}#${pr.number}`);
  console.log(`  mergeable          ${status.mergeable === null ? 'UNKNOWN' : status.mergeable}`);
  console.log(`  mergeStateStatus   ${status.mergeStateStatus ?? '?'}`);
  console.log(`  cr_verdict         ${crVerdict.verdict}${crVerdict.detail ? ` (${crVerdict.detail})` : ''}`);
  if (status.partial) {
    console.log(`  partial            true (${status.partialSurfaces.length} surfaces failed)`);
    for (const s of status.partialSurfaces) console.log(`    - ${s}`);
  }

  console.log('');
  console.log(`submitted reviews (${status.submittedReviews.length}):`);
  if (status.submittedReviews.length === 0) console.log('  (none)');
  for (const r of status.submittedReviews) console.log(renderReview(r));

  console.log('');
  console.log(`check-runs (${status.checkRuns.length}):`);
  if (status.checkRuns.length === 0) console.log('  (none)');
  for (const c of status.checkRuns) console.log(renderCheck(c.name, c.status, c.conclusion));

  console.log('');
  console.log(`legacy statuses (${status.legacyStatuses.length}):`);
  if (status.legacyStatuses.length === 0) console.log('  (none)');
  for (const s of status.legacyStatuses) console.log(renderCheck(s.context, s.state, null));

  console.log('');
  console.log(`unresolved line comments (${status.lineComments.length}):`);
  if (status.lineComments.length === 0) console.log('  (none)');
  for (const c of status.lineComments) console.log(renderComment(c));

  console.log('');
  console.log(`body-scoped nits (${status.bodyNits.length}):`);
  if (status.bodyNits.length === 0) console.log('  (none)');
  for (const c of status.bodyNits) console.log(renderComment(c));

  decideExitCode(status);
}

function decideExitCode(status) {
  // Exit code signals the broad readiness outcome so shell consumers
  // can gate on it. Matches the run-pr-landing exit convention:
  //   0 = CLEAN (mergeable + no blocking surfaces)
  //   1 = BLOCKED / partial (decision needed)
  //   2 = UNKNOWN (mergeable state still computing)
  if (status.partial) process.exit(1);
  if (status.mergeable === null || status.mergeStateStatus === null) process.exit(2);
  if (status.mergeStateStatus === 'CLEAN') process.exit(0);
  process.exit(1);
}

/**
 * Locate the newest pr-observation atom for (owner, repo, number).
 * Returns { status, ageMs, atomId, observedAt } or null. The atom's
 * metadata carries the composite snapshot; callers render from it
 * without re-querying GitHub.
 */
async function readLatestPrObservation({ owner, repo, number }) {
  try {
    const host = await createFileHost({ rootDir: STATE_DIR });
    const { atoms } = await host.atoms.query({ type: ['observation'] }, 500);
    // Filter on persisted PR identity in metadata, not just the atom
    // id prefix. Id-prefix alone collides between repos like `bar` vs
    // `bar-1`: id `pr-observation-o-bar-1-42-<sha>` matches BOTH the
    // `pr-observation-o-bar-` and `pr-observation-o-bar-1-` prefixes.
    // metadata.pr.{owner,repo,number} is the source of truth.
    const matches = atoms.filter((a) => {
      const md = a.metadata;
      if (!md || md.kind !== 'pr-observation') return false;
      const pr = md.pr;
      if (!pr) return false;
      return pr.owner === owner && pr.repo === repo && pr.number === number;
    });
    if (matches.length === 0) return null;
    matches.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const latest = matches[0];
    const observedAt = latest.metadata?.observed_at ?? latest.created_at;
    const ageMs = Date.now() - new Date(observedAt).getTime();
    // Rehydrate the composite-snapshot shape that the renderer expects.
    // Content-heavy fields (full comment bodies) were not persisted in
    // metadata; we reflect counts only and leave the per-item lists
    // empty. The atom's `content` string has the human-readable
    // summary with per-item detail if the operator wants it.
    const m = latest.metadata ?? {};
    const status = {
      pr: { owner, repo, number },
      mergeable: m.mergeable ?? null,
      mergeStateStatus: m.merge_state_status ?? null,
      lineComments: Array.from({ length: m.counts?.line_comments ?? 0 }, () => ({ id: '?', author: '(from atom)', body: '(see atom content)', resolved: false })),
      bodyNits: Array.from({ length: m.counts?.body_nits ?? 0 }, () => ({ id: '?', author: '(from atom)', body: '(see atom content)', resolved: false })),
      submittedReviews: Array.from({ length: m.counts?.submitted_reviews ?? 0 }, () => ({ author: '(from atom)', state: '?', submittedAt: '' })),
      checkRuns: Array.from({ length: m.counts?.check_runs ?? 0 }, () => ({ name: '(from atom)', status: '?', conclusion: null })),
      legacyStatuses: Array.from({ length: m.counts?.legacy_statuses ?? 0 }, () => ({ context: '(from atom)', state: '?', updatedAt: '' })),
      partial: m.partial ?? false,
      partialSurfaces: m.partial_surfaces ?? [],
    };
    return { status, ageMs, atomId: String(latest.id), observedAt, atomContent: latest.content };
  } catch {
    return null;
  }
}

function renderFromAtom(atomHit, pr) {
  const { status, ageMs, atomId, observedAt, atomContent } = atomHit;
  const ageS = Math.round(ageMs / 1000);
  console.log(`PR ${pr.owner}/${pr.repo}#${pr.number}`);
  console.log(`  source             pr-observation atom (${ageS}s old, id=${atomId})`);
  console.log(`  observed_at        ${observedAt}`);
  console.log(`  mergeable          ${status.mergeable === null ? 'UNKNOWN' : status.mergeable}`);
  console.log(`  mergeStateStatus   ${status.mergeStateStatus ?? '?'}`);
  // The cr_verdict surface requires a live issue-comments fetch
  // (atoms currently do not capture CR's summary-comment text).
  // Callers that need a definitive CR verdict should re-run with
  // the atom expired OR wait for the follow-up that stamps
  // cr_verdict into pr-observation metadata.
  console.log(`  cr_verdict         unknown-from-atom (wait for atom expiry or use a live-refresh path)`);
  if (status.partial) {
    console.log(`  partial            true (${status.partialSurfaces.length} surfaces failed)`);
    for (const s of status.partialSurfaces) console.log(`    - ${s}`);
  }
  console.log('');
  console.log('counts (from atom metadata):');
  console.log(`  submitted reviews       ${status.submittedReviews.length}`);
  console.log(`  check-runs              ${status.checkRuns.length}`);
  console.log(`  legacy statuses         ${status.legacyStatuses.length}`);
  console.log(`  unresolved line comments ${status.lineComments.length}`);
  console.log(`  body-scoped nits        ${status.bodyNits.length}`);
  console.log('');
  console.log('--- atom content (summary the observer posted as a PR comment) ---');
  console.log(atomContent);
}

main().catch((err) => {
  console.error(`[pr-status] FAILED: ${err?.message ?? err}`);
  process.exit(2);
});
