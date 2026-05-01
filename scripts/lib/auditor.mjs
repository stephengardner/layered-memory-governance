// scripts/lib/auditor.mjs
const RANK = { none: 0, docs: 1, tooling: 2, framework: 3, 'l3-canon-proposal': 4 };

export function classifyDiffBlastRadius(files) {
  if (!Array.isArray(files) || files.length === 0) return 'none';
  let max = 0;
  for (const f of files) {
    if (f.startsWith('scripts/bootstrap-') && f.endsWith('-canon.mjs')) {
      max = Math.max(max, RANK['l3-canon-proposal']);
    } else if (f.startsWith('src/')) {
      max = Math.max(max, RANK['framework']);
    } else if (f.startsWith('scripts/') || f === 'package.json' || f === 'package-lock.json' || f.endsWith('.yml') || f.endsWith('.yaml') || f.endsWith('.json')) {
      max = Math.max(max, RANK['tooling']);
    } else if (f.startsWith('docs/') || f.endsWith('.md')) {
      max = Math.max(max, RANK['docs']);
    } else {
      max = Math.max(max, RANK['tooling']);
    }
  }
  return Object.entries(RANK).find(([, r]) => r === max)?.[0] ?? 'none';
}

export function computeVerdict({ diffRadius, envelopeMax }) {
  if (RANK[diffRadius] <= RANK[envelopeMax]) {
    return { verdict: 'pass', reason: 'within envelope' };
  }
  return {
    verdict: 'fail',
    reason: `diff radius ${diffRadius} exceeds envelope ${envelopeMax}`,
  };
}

/**
 * Authorial gate the embedded-snapshot fallback path consults
 * before trusting JSON pulled out of the PR body.
 *
 * Returns true when the PR's author login matches the
 * configured trusted-author allowlist (`allowlistRaw`,
 * comma-separated). Defaults to the two surface forms the
 * lag-ceo App identity appears under in this codebase:
 *
 *   - `lag-ceo[bot]`: the commit-author / git-trailer form
 *     used when the bot writes commits (matches the on-disk
 *     identity App tokens mint).
 *   - `app/lag-ceo`: the slug-style form `gh pr view --jq
 *     '.author.login'` returns when the PR was opened by a
 *     GitHub App. The GraphQL `author { login }` resolver maps
 *     App PR-authors to this `app/<slug>` shape rather than the
 *     `<slug>[bot]` form gh CLI uses elsewhere, so the auditor
 *     sees a different string than the commit-author surfaces.
 *
 * Both forms refer to the same bot principal; including both in
 * the indie-floor default keeps the gate from rejecting
 * legitimate dispatch-bot PRs purely because the surface that
 * supplied the login string used a different vocabulary. A
 * deployment that opens autonomous PRs under a different role
 * (e.g. `lag-cto[bot]` / `app/lag-cto`) re-points the gate via
 * the `allowlistRaw` parameter (production threads
 * `process.env.LAG_AUDITOR_TRUSTED_PR_AUTHOR`) without a code
 * change.
 *
 * Returns false on null/undefined login or any unrecognised
 * identity; the caller fails-closed (refuses to read embedded
 * JSON) so a malicious user-opened PR cannot ship a forged
 * carrier and pass the audit.
 *
 * The substrate-pure rationale is that the dispatch flow is the
 * only legitimate carrier-emitter; gating on its identity
 * matches the bot-identity discipline canon enforces for every
 * other governance-visible action. A future hardening pass
 * replaces this with per-atom cryptographic signing the
 * dispatch flow attaches at PR-creation time; until then, the
 * authorial check is the strongest available without a new
 * signing infrastructure.
 *
 * Pure: takes the allowlist as a parameter rather than reading
 * process.env directly so callers (tests + production) can
 * supply distinct values without monkey-patching.
 */
export function isPrAuthorTrustedForEmbedded(authorLogin, allowlistRaw) {
  if (typeof authorLogin !== 'string' || authorLogin.length === 0) return false;
  // Trim before testing length so a whitespace-only override (e.g.
  // `LAG_AUDITOR_TRUSTED_PR_AUTHOR='   '`) is treated as unsupplied
  // and falls back to the indie default. Without the trim, the
  // whitespace passes the truthy gate, splits to one empty entry,
  // gets filtered out, and produces an empty allowlist that rejects
  // every legitimate dispatch-bot PR silently.
  const raw = typeof allowlistRaw === 'string' && allowlistRaw.trim().length > 0
    ? allowlistRaw
    : 'lag-ceo[bot],app/lag-ceo';
  const allowed = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return allowed.includes(authorLogin);
}
