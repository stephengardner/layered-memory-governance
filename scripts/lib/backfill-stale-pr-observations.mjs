/**
 * Pure helpers for scripts/backfill-stale-pr-observations.mjs.
 *
 * Tests import this module (shebang-free) and the main entrypoint
 * re-exports the helpers for callers that want them directly. Mirrors
 * the split pattern shipped by scripts/lib/cr-precheck.mjs and
 * scripts/lib/git-as.mjs (see canon `feedback_shebang_import_from_tests`):
 * vitest on Windows-CI cannot strip shebangs from `.mjs` files imported
 * by `.test.ts`, so the helpers live in a no-shebang module the tests
 * import directly while the main script keeps the shebang for direct
 * invocation.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

/** Default staleness window: 1 hour. Matches the synthesizer default. */
export const DEFAULT_STALENESS_MS = 60 * 60 * 1_000;

/** Default per-PR GitHub query timeout: 10 seconds. */
export const DEFAULT_PR_TIMEOUT_MS = 10_000;

/**
 * Parse argv into a structured options bag. Exposed for unit testing
 * so the tests can pin the contract without spawning a subprocess.
 *
 * @param {ReadonlyArray<string>} argv  argv slice WITHOUT `node script.mjs`
 * @returns {{
 *   apply: boolean,
 *   rootDir: string | undefined,
 *   stalenessMsOverride: number | undefined,
 *   prTimeoutMs: number,
 *   bot: string,
 * }}
 */
export function parseArgs(argv) {
  const args = {
    apply: argv.includes('--apply'),
    rootDir: undefined,
    stalenessMsOverride: undefined,
    prTimeoutMs: DEFAULT_PR_TIMEOUT_MS,
    bot: 'lag-ceo',
  };
  const rootIdx = argv.findIndex((a) => a === '--root');
  if (rootIdx >= 0 && argv[rootIdx + 1]) {
    args.rootDir = argv[rootIdx + 1];
  } else if (process.env.LAG_ROOT) {
    args.rootDir = process.env.LAG_ROOT;
  }
  const stalenessIdx = argv.findIndex((a) => a === '--staleness-ms');
  if (stalenessIdx >= 0 && argv[stalenessIdx + 1]) {
    const v = Number(argv[stalenessIdx + 1]);
    if (Number.isFinite(v) && v > 0) {
      args.stalenessMsOverride = v;
    }
  }
  const timeoutIdx = argv.findIndex((a) => a === '--pr-timeout-ms');
  if (timeoutIdx >= 0 && argv[timeoutIdx + 1]) {
    const v = Number(argv[timeoutIdx + 1]);
    if (Number.isFinite(v) && v > 0) {
      args.prTimeoutMs = v;
    }
  }
  const botIdx = argv.findIndex((a) => a === '--bot');
  if (botIdx >= 0 && argv[botIdx + 1]) {
    args.bot = argv[botIdx + 1];
  }
  return args;
}

/**
 * Read the staleness window from the canon atom set. Returns the
 * configured ms value, the override (when supplied), or
 * DEFAULT_STALENESS_MS.
 *
 * Pure: takes the atom array and returns a number. Exposed for tests.
 *
 * Mirrors the framework-side `readPrObservationStalenessMs` in the
 * Console synthesizer (apps/console/server/intent-outcome.ts):
 * strict L3-only canon filter so a non-canon-shaped atom cannot
 * impersonate the policy directive.
 *
 * @param {ReadonlyArray<unknown>} atoms
 * @param {number | undefined} override
 * @returns {number}
 */
export function resolveStalenessMs(atoms, override) {
  if (Number.isFinite(override) && override > 0) return override;
  for (const atom of atoms) {
    if (!atom || typeof atom !== 'object') continue;
    if (atom.type !== 'directive') continue;
    // Strict L3-only per CR finding 2026-05-11 (mirrors the framework
    // reader at canon-policy-cadence.ts): a non-canon-shaped atom
    // cannot influence the staleness policy.
    if (atom.layer !== 'L3') continue;
    if (atom.taint && atom.taint !== 'clean') continue;
    if (atom.superseded_by && atom.superseded_by.length > 0) continue;
    const meta = atom.metadata ?? {};
    const policy = meta.policy;
    if (!policy) continue;
    if (policy.subject !== 'pr-observation-staleness-ms') continue;
    const raw = policy.staleness_ms ?? policy.value;
    if (raw === 'Infinity') return Number.POSITIVE_INFINITY;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) continue;
    return raw;
  }
  return DEFAULT_STALENESS_MS;
}

/**
 * Query GitHub for the live PR state. Returns null on timeout or
 * subprocess error so a single stuck PR does not halt the script.
 *
 * Per-PR timeout is enforced by killing the subprocess after the
 * configured budget.
 *
 * @param {{ owner: string, repo: string, number: number }} pr
 * @param {{ bot: string, prTimeoutMs: number }} opts
 * @returns {Promise<{ state: 'MERGED' | 'CLOSED' | 'OPEN', mergedAt: string | null, mergeCommitSha: string | null, headSha: string } | null>}
 */
export async function queryPrState(pr, opts) {
  const { bot, prTimeoutMs } = opts;
  const ghAsPath = resolve(REPO_ROOT, 'scripts', 'gh-as.mjs');
  try {
    const result = await execa('node', [
      ghAsPath,
      bot,
      'pr',
      'view',
      String(pr.number),
      '--repo', `${pr.owner}/${pr.repo}`,
      '--json',
      'state,mergedAt,mergeCommit,headRefOid',
    ], {
      timeout: prTimeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      reject: false,
    });
    if (result.exitCode !== 0) return null;
    const raw = (result.stdout ?? '').toString().trim();
    if (raw.length === 0) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed.state !== 'string') return null;
    const state = parsed.state.toUpperCase();
    if (state !== 'MERGED' && state !== 'CLOSED' && state !== 'OPEN') {
      return null;
    }
    return {
      state,
      mergedAt: typeof parsed.mergedAt === 'string' ? parsed.mergedAt : null,
      mergeCommitSha: parsed.mergeCommit && typeof parsed.mergeCommit.oid === 'string'
        ? parsed.mergeCommit.oid
        : null,
      headSha: typeof parsed.headRefOid === 'string' && parsed.headRefOid.length > 0
        ? parsed.headRefOid
        : '',
    };
  } catch {
    // Timeout, JSON parse error, missing gh-as -- all treat as "couldn't
    // query". The script reports the skip in the summary; the operator
    // re-runs after fixing the transport issue.
    return null;
  }
}

/**
 * Build the fresh pr-observation atom that supersedes the stale one.
 *
 * Pure: takes structured inputs and returns the atom object. Exposed
 * for tests so a backfill heal can be verified without spawning the
 * full script.
 *
 * The atom-id generator is INJECTED so the tests can pin the contract
 * without dragging in the full dist tree. Production callers wire in
 * the canonical generator from dist/runtime/atoms/pr-observation-id.js.
 *
 * @param {{
 *   stale: any,
 *   live: { state: 'MERGED' | 'CLOSED' | 'OPEN', mergedAt: string | null, mergeCommitSha: string | null, headSha: string },
 *   nowIso: string,
 *   mkPrObservationAtomId: (owner: string, repo: string, number: number, headSha: string, observedAt: string) => string,
 * }} inputs
 * @returns {object}
 */
export function buildHealAtom(inputs) {
  const { stale, live, nowIso, mkPrObservationAtomId } = inputs;
  const staleMeta = stale.metadata ?? {};
  const pr = staleMeta.pr;
  const planId = staleMeta.plan_id;
  // headSha priority: live > staleMeta.head_sha > 'unknown'. Empty
  // string is the seam between "we know nothing" and the atom-id
  // generator; the generator slices the first 12 chars so an empty
  // input collapses to a stable 'unknown' bucket.
  const headSha = live.headSha.length > 0
    ? live.headSha
    : (typeof staleMeta.head_sha === 'string' && staleMeta.head_sha.length > 0
      ? staleMeta.head_sha
      : 'unknown');
  const atomId = mkPrObservationAtomId(
    pr.owner,
    pr.repo,
    pr.number,
    headSha,
    nowIso,
  );
  // Note: backfill-heal carries `partial: true` and `partial_surfaces:
  // ['all']` because the gh pr view query gives state + mergedAt +
  // mergeCommitSha but NOT the full review-tree (counts, reviews,
  // check-runs). A later full re-observation (run-pr-landing.mjs
  // --observe-only) hydrates those surfaces.
  return {
    schema_version: 1,
    id: atomId,
    content: [
      `**pr-observation heal for ${pr.owner}/${pr.repo}#${pr.number}** (substrate backfill)`,
      '',
      `observed_at: ${nowIso}`,
      `head_sha: \`${headSha}\``,
      `pr_state: ${live.state}`,
      live.mergedAt ? `merged_at: ${live.mergedAt}` : null,
      live.mergeCommitSha ? `merge_commit_sha: \`${live.mergeCommitSha}\`` : null,
      `plan_id: ${planId ?? '(none)'}`,
      'partial: true (backfill heal; full review tree not re-queried)',
      '',
      'Backfill rationale: the prior observation atom for this PR was',
      'older than the staleness window AND GitHub reports the PR in a',
      'terminal state. This atom supersedes the stale row so consumers',
      `(intent-outcome synthesizer, Pulse tile) see the live state.`,
    ].filter((line) => line !== null).join('\n'),
    type: 'observation',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: {
        agent_id: 'backfill-stale-pr-observations',
        tool: 'backfill-stale-pr-observations',
      },
      // Chain through the stale atom AND the original plan so an audit
      // walk lands on both. The stale atom is the prior observation;
      // chaining to it preserves the supersession history.
      derived_from: [
        stale.id,
        ...(typeof planId === 'string' ? [planId] : []),
      ],
    },
    confidence: 0.85,
    created_at: nowIso,
    last_reinforced_at: nowIso,
    expires_at: null,
    supersedes: [stale.id],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: 'pr-landing-agent',
    taint: 'clean',
    metadata: {
      kind: 'pr-observation',
      pr: { owner: pr.owner, repo: pr.repo, number: pr.number },
      head_sha: headSha,
      observed_at: nowIso,
      pr_state: live.state,
      ...(planId ? { plan_id: planId } : {}),
      partial: true,
      partial_surfaces: ['all'],
      counts: {
        line_comments: 0,
        body_nits: 0,
        submitted_reviews: 0,
        check_runs: 0,
        legacy_statuses: 0,
      },
      mergeable: null,
      merge_state_status: null,
      ...(live.mergedAt ? { merged_at: live.mergedAt } : {}),
      ...(live.mergeCommitSha ? { merge_commit_sha: live.mergeCommitSha } : {}),
      backfill: {
        reason: 'staleness-window-exceeded-pr-terminal-on-github',
        superseded_atom_id: stale.id,
        backfilled_at: nowIso,
      },
    },
  };
}
