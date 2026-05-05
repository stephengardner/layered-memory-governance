// Pure helpers for scripts/invokers/autonomous-dispatch.mjs.
// Extracted into a shebang-free module so the test can static-import
// them without firing the script's CLI side effects, mirroring the
// pattern landed for git-as-push-auth.mjs.

import { createHash } from 'node:crypto';
import {
  buildPushEnv,
  buildReadOnlyEnv,
} from './git-as-push-auth.mjs';

// GitHub label names are capped at 50 characters. Plan-atom ids in
// this codebase routinely exceed that (e.g. 91 chars for pipeline-
// generated plans like
// `plan-add-one-line-pointer-to-docs-framework-m-cto-actor-pipeline-cto-1777622668718-vh8a0j-0`).
// A naive `plan-id:<full-id>` label hits HTTP 422 and the LAG-auditor
// gate never fires on the autonomous PR.
//
// The truncated form keeps the `plan-id:` prefix (the workflow's
// `select(.name | startswith("plan-id:"))` filter relies on it),
// preserves the human-readable head of the plan id, and appends a
// short sha-256 hex digest so two plans whose ids share a long
// prefix (multi-task plans differ only at the trailing index) do not
// collide on the same label. The auditor uses the full plan id from
// the PR body's machine-parseable provenance footer; the label is
// only the workflow trigger marker. The chosen layout is:
//   plan-id:<head>-<hash>   where head = first PLAN_ID_LABEL_HEAD chars
//                            and  hash = first PLAN_ID_LABEL_HASH hex chars
export const PLAN_ID_LABEL_PREFIX = 'plan-id:';
const PLAN_ID_LABEL_MAX = 50;
const PLAN_ID_LABEL_HASH = 12;
// Reserve room for prefix + '-' separator + hash so the truncated
// label is exactly PLAN_ID_LABEL_MAX chars on the truncate path.
const PLAN_ID_LABEL_HEAD =
  PLAN_ID_LABEL_MAX - PLAN_ID_LABEL_PREFIX.length - 1 - PLAN_ID_LABEL_HASH;

/**
 * Parse a `GH_REPO=owner/repo` env value.
 * Returns { owner, repo } when the input is well-formed, or null
 * otherwise (caller falls back to `gh repo view`). Reject over-
 * segmented inputs like `org/team/repo` instead of silently
 * truncating to `{owner:'org', repo:'team'}`; the prior
 * `split('/', 2)` form would have dispatched against the wrong
 * repo on a typo, with no diagnostic.
 */
export function parseRepoSlug(slug) {
  if (typeof slug !== 'string') return null;
  const trimmed = slug.trim();
  const parts = trimmed.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  return { owner, repo };
}

/**
 * Parse the `plan_id` field out of a PR body's machine-parseable
 * provenance footer (a YAML block emitted by buildPrBody in
 * src/runtime/actors/code-author/pr-creation.ts):
 *
 *   ```yaml
 *   plan_id: "<full-plan-atom-id>"
 *   observation_atom_id: "..."
 *   commit_sha: "..."
 *   ```
 *
 * Returns the unescaped plan id string when present, otherwise null.
 * The auditor falls back to this when the workflow-supplied label-
 * derived id can't be resolved against the atom store (because
 * truncatePlanIdLabel had to shorten it to fit GitHub's 50-char
 * label limit). The label is the workflow trigger marker, the body
 * footer is the canonical machine-readable carrier.
 *
 * The regex is anchored to a line beginning so a stray `plan_id`
 * mention in surrounding prose can't shadow the YAML field. Strict
 * JSON.parse on the captured group rejects malformed escapes
 * instead of silently returning a half-decoded string.
 */
export function parsePlanIdFromPrBody(body) {
  if (typeof body !== 'string' || body.length === 0) return null;
  // Negated class excludes raw `\n` so the match cannot span lines
  // and pull in a closing quote from a sibling YAML field. The
  // canonical buildPrBody output emits `JSON.stringify(planId)`,
  // which already escapes any literal newline in the id as `\\n`,
  // so a newline reaching this regex is a malformed body and the
  // safer behaviour is no-match -> null.
  const match = /^plan_id:\s*"((?:[^"\\\n]|\\.)*)"\s*$/m.exec(body);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return null;
  }
}

/**
 * Section heading the dispatch-side renderer (renderPrBody in
 * src/runtime/actors/code-author/pr-creation.ts) emits before the
 * embedded-atom <details> blocks. Lifted to a module constant so
 * the dispatch-side and auditor-side anchor the same string; a
 * drift between the two would silently disable the embedded-atom
 * carrier flow that fixes the LAG-auditor CI gap (the workflow
 * runs on a runner with no .lag/atoms/ directory and no named
 * tunnel, so the embedded JSON in the PR body is the only way the
 * auditor can resolve the plan + operator-intent snapshots).
 *
 * NOTE: must stay in sync with EMBEDDED_ATOMS_HEADING in
 * src/runtime/actors/code-author/pr-creation.ts. A future refactor
 * that wants to share the constant across the .ts/.mjs boundary
 * can promote it into the dist/ output (or a JSON manifest) once
 * we have a bigger reason to do that work.
 */
export const EMBEDDED_ATOMS_HEADING = '## Embedded atom snapshots';

/**
 * Parse an atom JSON snapshot embedded in a PR body's
 * `<details>...```json...```...</details>` block keyed by atom id.
 *
 * Returns the parsed atom object on success, or null when:
 *   - body is null/undefined/empty
 *   - no <details> block matches the embedded-atoms section
 *   - the requested atomId has no embedded snapshot
 *   - the JSON payload is malformed
 *   - the parsed payload's `id` field does not equal the requested
 *     atomId (round-trip integrity guard; symmetric with how
 *     parsePlanIdFromPrBody validates the YAML footer's plan_id
 *     before trusting it)
 *
 * The id-mismatch guard is the load-bearing security check: a
 * malicious PR-body edit could ship a plan-shaped atom under a
 * legitimate atom id's <details> heading, redirecting the auditor
 * at an unrelated payload whose envelope might happen to permit
 * the diff. Comparing the embedded payload's own `id` to the
 * caller-supplied lookup id rejects that path; the embedded
 * snapshot must self-identify with the same id the lookup
 * specified.
 *
 * Multiple <details> blocks per body are supported (the renderer
 * emits one per atom); the parser scans them in order and returns
 * the first match for the requested atomId.
 */
export function parseEmbeddedAtomFromPrBody(body, atomId) {
  if (typeof body !== 'string' || body.length === 0) return null;
  if (typeof atomId !== 'string' || atomId.length === 0) return null;
  // Only scan inside the embedded-atoms section so a stray
  // <details> elsewhere in the body cannot shadow a missing
  // embedded snapshot. Anchored to the heading the renderer emits.
  const sectionStart = body.indexOf(EMBEDDED_ATOMS_HEADING);
  if (sectionStart < 0) return null;
  const section = body.slice(sectionStart);
  // Each block's <summary> carries the atom id with the literal
  // marker text 'atom: '. Iterate over every <details> block in
  // the section and inspect the JSON payload to find the match;
  // the summary text is HTML-escaped for rendering purposes and is
  // NOT the integrity gate the lookup compares against (the
  // parsed payload's `id` field is the canonical identifier per
  // the round-trip security note above).
  const blockRegex = /<details><summary>atom: [^<]*<\/summary>\s*```json\s*([\s\S]*?)\s*```\s*<\/details>/g;
  let match;
  while ((match = blockRegex.exec(section)) !== null) {
    const jsonText = match[1];
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      // Malformed JSON in this block: keep scanning later blocks
      // because the renderer always emits valid JSON, but a
      // mid-section corruption should not silently disable later
      // valid blocks. A multi-block body where one entry is
      // malformed still surfaces the others.
      continue;
    }
    if (parsed && typeof parsed === 'object' && parsed.id === atomId) {
      return parsed;
    }
  }
  return null;
}

/**
 * Build the GitHub label name for a plan id, capped at 50 chars.
 *
 * Returns `plan-id:<id>` when the full id fits, otherwise
 * `plan-id:<head>-<hash>` where head = the first PLAN_ID_LABEL_HEAD
 * characters of the plan id and hash = the first PLAN_ID_LABEL_HASH
 * hex digits of `sha256(planId)`. The combined truncated form is
 * exactly PLAN_ID_LABEL_MAX characters so the GitHub Issues API
 * accepts it. The hash component avoids collisions when two plan
 * ids share a long prefix (e.g. multi-task plans whose ids differ
 * only at the trailing index suffix).
 *
 * The full plan id remains available to consumers via the PR body's
 * machine-parseable provenance footer (`plan_id: "<full-id>"`); the
 * label here is the workflow-trigger marker, not the canonical
 * carrier. See .github/workflows/pr-landing.yml lag-auditor job.
 *
 * Throws on non-string or empty input rather than emitting a
 * malformed label that would silently route the PR through an
 * unconfigured auditor path.
 */
export function truncatePlanIdLabel(planId) {
  if (typeof planId !== 'string' || planId.length === 0) {
    throw new Error(
      `[autonomous-dispatch] truncatePlanIdLabel: planId must be a non-empty string, got ${typeof planId}`,
    );
  }
  const full = `${PLAN_ID_LABEL_PREFIX}${planId}`;
  if (full.length <= PLAN_ID_LABEL_MAX) return full;
  const head = planId.slice(0, PLAN_ID_LABEL_HEAD);
  const hash = createHash('sha256').update(planId).digest('hex').slice(0, PLAN_ID_LABEL_HASH);
  return `${PLAN_ID_LABEL_PREFIX}${head}-${hash}`;
}

/**
 * Detect a push command in a git argv that may carry git-level `-c`
 * options before the verb. Skip git-level flags (`-c key=val`,
 * `-C dir`, single-letter switches) and report whether the first
 * non-flag positional is `push`. This avoids the false positive a
 * naive `args.includes('push')` would emit on a benign refspec named
 * `push` (e.g. `git fetch origin push`); the shared isPushCommand
 * helper instead misclassifies `-c user.name=foo push origin` as a
 * read because it bails on the first non-`-` token, which is the gap
 * this helper exists to plug.
 *
 * Verbs are git's positional commands (push, fetch, clone, ...).
 * Anything before the verb is either a flag, a flag value, or
 * unrecognized; once we see the verb, that token decides routing.
 */
export function looksLikeGitPush(args) {
  if (!Array.isArray(args)) return false;
  return findGitVerb(args) === 'push';
}

/**
 * Walk a git argv past git-level options and return the first
 * positional token (the verb), or null if no verb is reachable.
 * Handles the two value-taking git-level options the dispatcher
 * actually emits (`-c <key>=<val>` from git-ops, `-C <dir>` from
 * tooling); other long flags are treated as boolean. Mirrors the
 * structure of findRemoteArg in git-as-push-auth.mjs.
 */
function findGitVerb(args) {
  const valueTaking = new Set(['-c', '-C']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') return null;
    if (a === '--') {
      return args[i + 1] ?? null;
    }
    if (a.startsWith('-')) {
      if (valueTaking.has(a)) {
        i += 1; // skip the value
        continue;
      }
      // Inline value form (e.g. `-C=dir`, `--git-dir=.git`) is one
      // token; ignore it entirely.
      continue;
    }
    return a;
  }
  return null;
}

/**
 * Build the (args, env) overrides a token-authed git invocation
 * should spawn with. Pure: callers compose the tuple with execa
 * themselves and spread `process.env` so tests can inject a clean
 * env without leaking real credentials.
 *
 *   - Remote-touching verbs (push, fetch, pull, clone, ls-remote):
 *     rewrite the remote-arg position to a transient
 *     x-access-token URL via the in-file rewriteGitRemoteArg, then
 *     merge env overrides from buildPushEnv (clears the ambient
 *     credential helper so git does not prompt for a username).
 *     The Bearer http.extraHeader path used for `gh api` does NOT
 *     authenticate git's smart-http on Windows; the URL-embedded
 *     x-access-token form is the only auth method that works
 *     uniformly for receive-pack AND upload-pack across platforms.
 *   - Local-only verbs (status, log, rev-parse, config, ...): keep
 *     argv intact, merge the GIT_CONFIG_* env from buildReadOnlyEnv
 *     (Authorization: Bearer extraheader for the few local
 *     operations that may still hit a remote, plus credential
 *     helper clear). The remote-rewrite branch returns null for
 *     these, falling through to this path.
 *
 * The returned shape (args, env) is what execa's positional args
 * consume after the file argument.
 */
export function buildAuthedGitInvocation({
  args,
  token,
  repoOwner,
  repoName,
  inheritedEnv,
  callerEnv = {},
}) {
  // For ALL git-protocol commands that touch a remote (push, fetch,
  // pull, clone, ls-remote), rewrite the remote-arg position to a
  // transient x-access-token URL. The Bearer http.extraHeader path
  // works for `gh api` (GitHub's REST/GraphQL surface) but does NOT
  // authenticate git's smart-http protocol on Windows: GitHub
  // rejects the bearer for receive-pack AND upload-pack with a 401,
  // git falls through to the credential helper, askpass disabled
  // produces "could not read Username for 'https://github.com'".
  // The URL-embedded x-access-token form is the only auth method
  // that works uniformly across all git remote verbs on Windows +
  // Linux.
  const remoteRewrite = rewriteGitRemoteArg(args, token, repoOwner, repoName);
  if (remoteRewrite !== null) {
    return {
      args: remoteRewrite,
      env: { ...inheritedEnv, ...callerEnv, ...buildPushEnv() },
    };
  }
  // Local-only git commands (status, log, rev-parse, config, etc.)
  // need no auth. Apply the read-only env defensively to clear any
  // ambient credential helper that might prompt unexpectedly.
  return {
    args,
    env: { ...inheritedEnv, ...callerEnv, ...buildReadOnlyEnv(token) },
  };
}

/**
 * If the argv invokes a git verb that talks to a remote, return a
 * new argv with the remote-arg position rewritten to the transient
 * x-access-token URL. Otherwise return null (caller treats as
 * local-only, no auth needed).
 *
 * Walks past git-level options (`-c k=v`, `-C dir`, `--`) the same
 * way findGitVerb does so the upstream `-c user.name=...` prefix
 * git-ops emits does not misclassify the verb. The first positional
 * AFTER the verb is the remote arg for push/fetch/pull/ls-remote;
 * for clone the remote arg is the first positional after the verb
 * too. Subcommand-specific quirks (e.g. `git push --repo <name>`
 * with no positional) are not supported because git-ops never emits
 * them.
 */
const REMOTE_GIT_VERBS = new Set([
  'push',
  'fetch',
  'pull',
  'clone',
  'ls-remote',
]);

/**
 * Recognise a transient `gh REST pulls create` 5xx error in an
 * executor failure's `reason` string. Returns true for the 5xx
 * shapes the dispatch flow has observed in production:
 *
 *   - 504 Gateway Timeout (today's dogfeed-13 evidence: PR is
 *     sometimes created server-side anyway but the gh CLI returns
 *     non-zero before reading the response).
 *   - 502 Bad Gateway (same shape, observed less often; recovery
 *     is identical).
 *
 * The detector is intentionally narrow. It matches the literal
 * status-code marker the gh CLI emits (`HTTP 504`, `HTTP/1.1 504`,
 * `status code 504`, etc.) rather than attempting to recognise
 * every flavour of "transient": a 401/403 would be a token /
 * scope issue and probing for an orphaned PR is the wrong remedy
 * (the token cannot read the listing either, so the probe fails
 * with the same auth error). 4xx errors are always treated as
 * structural and short-circuit; 5xx is the narrow recovery
 * surface.
 *
 * Pure: takes a string, returns a boolean. Callers compose the
 * detection with the orphaned-PR probe themselves.
 */
const TRANSIENT_5XX_RE = /\b50[24]\b/;

export function isTransientPrCreationGatewayError(reason) {
  if (typeof reason !== 'string' || reason.length === 0) return false;
  return TRANSIENT_5XX_RE.test(reason);
}

/**
 * Probe for an orphaned PR by branch head via `gh pr list --head`,
 * spawning the supplied execImpl so callers (production +
 * tests) share one wire-shape. Returns `{ number, htmlUrl }` on
 * exact-one-match or null otherwise:
 *
 *   - branch null/undefined/empty: no probe, returns null. The
 *     executor failed before the branch reached the remote;
 *     there is nothing to recover.
 *   - gh CLI exits non-zero: returns null. A failed probe is
 *     indistinguishable from "no PR exists" at this layer; the
 *     caller (the dispatch wrapper) logs the underlying gh
 *     stderr and falls through to the original 5xx error.
 *   - empty array result: returns null. No orphaned PR; the
 *     5xx must have been an actual create-side failure, not a
 *     create-then-server-error race.
 *   - exactly-one PR: returns its number + htmlUrl. The dispatch
 *     wrapper treats this as success and continues with labels.
 *   - multiple matching PRs: returns null. Two PRs on the same
 *     head branch is anomalous (GitHub disallows it on the same
 *     base branch but a refspec edge case could in principle
 *     produce it); fail-closed and let the operator inspect.
 *
 * The repo slug is required because `gh pr list --head` is repo-
 * scoped and a missing slug would default to the working-dir
 * repo, which is correct in normal operation but wrong when the
 * dispatcher is invoked from a worktree pointing at a different
 * upstream. Callers always pass the dispatch-resolved owner/repo.
 *
 * The execImpl is the same authed-git/gh shim the dispatch flow
 * builds; threading it here keeps the bot-identity discipline
 * uniform (the probe runs as the dispatch bot, never the
 * operator's PAT).
 */
export async function probeOrphanedPrByBranch({
  branch,
  owner,
  repo,
  execImpl,
}) {
  if (typeof branch !== 'string' || branch.length === 0) return null;
  if (typeof owner !== 'string' || owner.length === 0) return null;
  if (typeof repo !== 'string' || repo.length === 0) return null;
  if (typeof execImpl !== 'function') return null;
  let result;
  try {
    result = await execImpl('gh', [
      'pr', 'list',
      '--repo', `${owner}/${repo}`,
      '--head', branch,
      '--state', 'open',
      '--json', 'number,url',
    ], { reject: false });
  } catch {
    return null;
  }
  if (!result || result.exitCode !== 0) return null;
  const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (stdout.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) return null;
  const entry = parsed[0];
  if (!entry || typeof entry !== 'object') return null;
  const number = entry.number;
  const url = entry.url;
  if (typeof number !== 'number' || typeof url !== 'string' || url.length === 0) {
    return null;
  }
  return { number, htmlUrl: url };
}

/**
 * Parse a GitHub remote URL into `{ owner, repo }`.
 *
 * Accepts the two forms `git remote get-url origin` actually emits in
 * this codebase:
 *   - https://github.com/<owner>/<repo>(.git)?
 *   - git@github.com:<owner>/<repo>(.git)?
 *
 * The transient x-access-token form
 * (`https://x-access-token:<token>@github.com/...`) is also accepted
 * so a worktree whose remote was rewritten in-place by a previous
 * dispatch (the historical -u footgun fixed in PR #169) still parses
 * cleanly. The userinfo is stripped before the path component is
 * matched.
 *
 * Returns `null` for any non-GitHub URL, malformed input, or empty
 * owner/repo. The caller treats null as "could not verify", which
 * the sanity check below converts into a fail-fast escalation rather
 * than a silent skip; an unparseable remote is a strong signal that
 * the dispatch is not pointed at the configured repo.
 */
export function parseGitHubRemoteUrl(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  // HTTPS form (with optional userinfo for the x-access-token rewrite
  // path). The userinfo is captured loosely so a token containing
  // `:` does not break the parse; we discard it either way.
  const httpsMatch = /^https:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(trimmed);
  if (httpsMatch) {
    const owner = httpsMatch[1];
    const repo = httpsMatch[2];
    if (owner.length === 0 || repo.length === 0) return null;
    return { owner, repo };
  }
  // SSH form. Single-pattern: `git@github.com:<owner>/<repo>(.git)?`.
  const sshMatch = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(trimmed);
  if (sshMatch) {
    const owner = sshMatch[1];
    const repo = sshMatch[2];
    if (owner.length === 0 || repo.length === 0) return null;
    return { owner, repo };
  }
  return null;
}

/**
 * Verify that the local checkout at `repoDir` points at the same
 * `(owner, repo)` the dispatcher resolved upstream (via `gh repo view`
 * or the `GH_REPO` env var).
 *
 * Why this exists
 * ---------------
 * The dispatch chain reads `repoDir = resolve(LAG_REPO_DIR ?? process.cwd())`
 * and resolves `(owner, repo)` separately through `resolveOwnerRepo`.
 * Those two reads can disagree:
 *   - `LAG_REPO_DIR` env var leaked from a sibling shell pointing at a
 *     different checkout;
 *   - `process.cwd()` is a different repo because the operator invoked
 *     run-cto-actor.mjs from one;
 *   - `GH_REPO` env or `gh repo view` returns a stale value (e.g. the
 *     gh CLI pointed at an unrelated active repo);
 *   - `repoDir`'s `origin` remote was reconfigured to a non-target
 *     repo without re-running the dispatch wiring.
 *
 * On every one of those paths the executor would acquire a worktree
 * off the wrong checkout, the drafter would see no relevant tree, and
 * the dispatch silently no-ops with `drafter-emitted-empty-diff`. The
 * guard fails closed at register-time so the operator sees the
 * mismatch immediately instead of after a billable LLM call.
 *
 * Pure-function shape
 * -------------------
 * The reader is injected so tests can pin every branch without
 * spawning git. `gitRemoteUrlReader(repoDir)` returns the URL string
 * (typically the stdout of `git remote get-url origin`), or `null`
 * when no `origin` remote is configured. Throwing is also valid; the
 * caller maps any exception to a fail-closed result.
 *
 * Returns `{ ok: true }` on match, or `{ ok: false, reason }` on any
 * fail-closed condition. The reason string is operator-facing prose.
 */
export async function verifyDispatchRepoIdentity({
  repoDir,
  expectedOwner,
  expectedRepo,
  gitRemoteUrlReader,
}) {
  if (typeof repoDir !== 'string' || repoDir.length === 0) {
    return {
      ok: false,
      reason: 'repoDir must be a non-empty string',
    };
  }
  if (typeof expectedOwner !== 'string' || expectedOwner.length === 0) {
    return {
      ok: false,
      reason: 'expectedOwner must be a non-empty string',
    };
  }
  if (typeof expectedRepo !== 'string' || expectedRepo.length === 0) {
    return {
      ok: false,
      reason: 'expectedRepo must be a non-empty string',
    };
  }
  if (typeof gitRemoteUrlReader !== 'function') {
    return {
      ok: false,
      reason: 'gitRemoteUrlReader must be a function',
    };
  }
  let url;
  try {
    url = await gitRemoteUrlReader(repoDir);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `git remote get-url origin failed for repoDir='${repoDir}': ${cause}. `
        + `The dispatcher resolved ${expectedOwner}/${expectedRepo} via gh repo view / GH_REPO, `
        + 'but the local checkout has no readable origin. Set LAG_REPO_DIR to the correct '
        + 'checkout or configure the origin remote before dispatching.',
    };
  }
  if (url === null || (typeof url === 'string' && url.length === 0)) {
    return {
      ok: false,
      reason: `repoDir='${repoDir}' has no 'origin' remote configured. `
        + `The dispatcher resolved ${expectedOwner}/${expectedRepo} via gh repo view / GH_REPO; `
        + 'an unconfigured origin means the dispatch would push to a remote the resolved '
        + "owner/repo can't authenticate. Add 'origin' or set LAG_REPO_DIR to the right checkout.",
    };
  }
  const parsed = parseGitHubRemoteUrl(url);
  if (parsed === null) {
    return {
      ok: false,
      reason: `repoDir='${repoDir}' origin remote url '${url}' is not a parseable GitHub URL. `
        + 'Supported shapes: https://github.com/owner/repo[.git] or git@github.com:owner/repo[.git]. '
        + 'The dispatch flow ships only against GitHub-hosted repos; reconfigure origin or fix '
        + 'LAG_REPO_DIR.',
    };
  }
  // Case-insensitive comparison: GitHub treats owner/repo as case-
  // insensitive in both REST API path params and clone URLs (a user
  // who cloned `https://github.com/StephenGardner/Layered-Autonomous-
  // Governance.git` and a `gh repo view` returning the canonical
  // lowercase form must compare equal). A strict-equal check would
  // false-flag the mixed-case clone as a wrong-repo dispatch and
  // block the operator from running until they re-cloned with
  // matching casing -- exactly the kind of papercut this guard
  // exists to prevent, not produce.
  if (
    parsed.owner.toLowerCase() !== expectedOwner.toLowerCase()
    || parsed.repo.toLowerCase() !== expectedRepo.toLowerCase()
  ) {
    return {
      ok: false,
      reason: `repoDir='${repoDir}' origin remote points at ${parsed.owner}/${parsed.repo}, `
        + `but the dispatcher resolved ${expectedOwner}/${expectedRepo} via gh repo view / GH_REPO. `
        + 'These MUST agree: the executor acquires its workspace off this checkout and pushes '
        + 'with credentials minted for the resolved owner/repo, so a mismatch means the LLM '
        + 'sees the wrong tree (silent-skip / drafter-emitted-empty-diff) and the push would '
        + "land on the wrong remote. Either re-run with LAG_REPO_DIR pointing at the correct "
        + 'checkout, or correct GH_REPO so it matches the local origin.',
    };
  }
  return { ok: true };
}

function rewriteGitRemoteArg(args, token, repoOwner, repoName) {
  if (!Array.isArray(args)) return null;
  const valueTaking = new Set(['-c', '-C']);
  let i = 0;
  let verbIndex = -1;
  while (i < args.length) {
    const a = args[i];
    if (typeof a !== 'string') return null;
    if (a === '--') {
      // Next token is the verb.
      if (i + 1 < args.length && REMOTE_GIT_VERBS.has(args[i + 1])) {
        verbIndex = i + 1;
        break;
      }
      return null;
    }
    if (a.startsWith('-')) {
      if (valueTaking.has(a)) {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (REMOTE_GIT_VERBS.has(a)) {
      verbIndex = i;
    }
    break;
  }
  if (verbIndex < 0) return null;

  // First positional after the verb is the remote name (or URL).
  // For clone the positional is the URL itself; rewriting it to
  // the transient form keeps the auth surface uniform.
  let remoteIndex = -1;
  for (let j = verbIndex + 1; j < args.length; j++) {
    const a = args[j];
    if (typeof a !== 'string') continue;
    if (a.startsWith('-')) continue;
    remoteIndex = j;
    break;
  }
  if (remoteIndex < 0) return null;

  // Validate the remote points at the dispatch-configured repo
  // before rewriting. Accepting only:
  //   - 'origin' (the conventional remote, set by the dispatcher
  //     during clone), or
  //   - https://github.com/<owner>/<repo>(.git)? where (owner, repo)
  //     match the configured (repoOwner, repoName).
  // Anything else (a different GitHub repo, a non-GitHub host, an
  // arbitrary upstream remote name like 'upstream') falls through
  // and the caller treats the invocation as local-only. The
  // dispatch flow never legitimately addresses a non-target remote;
  // silently rewriting one would erase user intent and could
  // exfiltrate the access token to the wrong host.
  const remoteArg = args[remoteIndex];
  if (remoteArg !== 'origin') {
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remoteArg);
    if (!match || match[1] !== repoOwner || match[2] !== repoName) {
      return null;
    }
  }

  const transient = `https://x-access-token:${token}@github.com/${repoOwner}/${repoName}.git`;
  const next = args.slice();
  next[remoteIndex] = transient;
  return next;
}
