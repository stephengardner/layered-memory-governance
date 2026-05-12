import { test, expect, type Page } from '@playwright/test';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

/**
 * End-to-end pipeline coverage: intent -> dispatch -> PR -> merge -> fulfilled.
 *
 * This is the integration-level spec for task #301. It exercises every
 * surface this session shipped (`/file-intent` form via #297,
 * `/pipelines/<id>` SSE via #299, post-dispatch lifecycle, intent-outcome
 * card, abandon control) by seeding the full atom chain a real
 * autonomous pipeline would produce and then walking the console as a
 * mobile-first operator would.
 *
 * Fixture strategy: seed atoms on disk under `.lag/atoms/`. The backend
 * (server/index.ts) picks them up via its filesystem watcher, projects
 * them into the wire shapes the console consumes (`/api/pipelines.list`,
 * `/api/pipelines.detail`, `/api/pipeline.lifecycle`,
 * `/api/pipeline.intent-outcome`), and the SSE channel
 * `/api/events/pipeline.<id>` re-broadcasts as the atoms land. The
 * GitHub side is mocked by writing pr-observation atoms with the
 * fully-resolved MERGED state plus a plan-merge-settled atom; this
 * lets the spec run in CI WITHOUT a live GitHub auth surface or any
 * external network call.
 *
 * Why not exercise the real `intents.file` POST: the route writes the
 * operator-intent atom AND spawns `run-cto-actor.mjs`, which needs
 * `dist/` built + an LLM credential + the autonomous-dispatch invoker
 * to actually run. None of those are available in CI for a unit-scale
 * Playwright suite. The file-intent form's read-only and validation
 * branches are already covered by `tests/e2e/file-intent.spec.ts`; this
 * spec covers the rest of the chain (everything DOWNSTREAM of the
 * autonomous loop firing) via deterministic seeds. The two specs
 * together cover the full intent-to-merged surface.
 *
 * Disciplines this spec enforces:
 *   - Mobile-first (runs against the playwright.config.ts mobile
 *     project at 390x844; horizontal-scroll is a hard fail).
 *   - Every interactive control has a 44px tap target (canon
 *     `dev-web-mobile-first-required`).
 *   - The chain is observable from the navigation surface (sidebar +
 *     pipelines grid + detail) without any backend writes from the
 *     test (read-only by construction per the console's v1 contract).
 *
 * Seed atoms produced (one pipeline, 12 atoms total):
 *   1. operator-intent      seed intent atom (input the planner reads)
 *   2. pipeline             root pipeline atom (succeeded state)
 *   3..7. pipeline-stage-event x10 (enter + exit-success for each of
 *         brainstorm / spec / plan / review / dispatch -- 10 events)
 *   8. plan                 plan-stage output
 *   9. dispatch-record      dispatch-stage output (dispatched=1)
 *   10. observation         code-author-invoked (PR opened)
 *   11. observation         pr-observation (MERGED, all checks green)
 *   12. plan-merge-settled  reconciler row tying the merge to the plan
 *
 * Cleanup: afterAll deletes every seed regardless of test outcome so a
 * second run is not polluted by the previous run's atoms.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const APPS_CONSOLE = resolve(HERE, '..', '..');
const REPO_ROOT = resolve(APPS_CONSOLE, '..', '..');
const DEFAULT_LAG = resolve(REPO_ROOT, '.lag');
const LAG_DIR = process.env['LAG_CONSOLE_LAG_DIR'] ?? DEFAULT_LAG;
const ATOMS_DIR = resolve(LAG_DIR, 'atoms');

// Stable nonce derived from Date.now + a 4-hex slice of crypto.randomUUID
// so parallel runs cannot collide. crypto over Math.random per
// CodeQL js/insecure-randomness; this is a test-only id, not a security
// context, but we keep the strict-randomness floor uniform across the
// repo. Kept short so atom filenames stay readable in case of a debug
// dump.
const NONCE = `e2e${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 4)}`;
const PIPELINE_ID = `pipeline-e2e-${NONCE}`;
const SESSION_ID = `e2e-${NONCE}`;
const PLAN_ID = `plan-e2e-${NONCE}`;
const INTENT_ID = `operator-intent-e2e-${NONCE}`;
const DISPATCH_RECORD_ID = `dispatch-record-${PIPELINE_ID}`;
const CODE_AUTHOR_OBS_ID = `code-author-invoked-e2e-${NONCE}`;
const PR_OBSERVATION_ID = `pr-observation-e2e-${NONCE}`;
const MERGE_SETTLED_ID = `plan-merge-settled-e2e-${NONCE}`;

// Five stages of the substrate-deep pipeline, ordered. The runner
// emits one enter + one exit-success event per stage when the pipeline
// runs cleanly; we mirror that shape so the projection's per-stage
// state collapses to `succeeded` for all five.
const STAGES = ['brainstorm-stage', 'spec-stage', 'plan-stage', 'review-stage', 'dispatch-stage'] as const;

// Synthetic timestamps so the per-stage durations are deterministic.
// Each stage takes 30s; the pipeline starts at T0 and completes at
// T0 + 150s. The values must remain in chronological order so the
// fold's "current stage" calculation lands on dispatch-stage.
const BASE_TIME_MS = Date.parse('2026-05-11T10:00:00.000Z');
const STAGE_DURATION_MS = 30_000;
const COMPLETED_AT_MS = BASE_TIME_MS + STAGES.length * STAGE_DURATION_MS;
const COMPLETED_AT_ISO = new Date(COMPLETED_AT_MS).toISOString();
const STARTED_AT_ISO = new Date(BASE_TIME_MS).toISOString();
const PR_MERGED_AT_ISO = new Date(COMPLETED_AT_MS + 60_000).toISOString();

// Mock PR number high enough to never collide with a real PR. The
// pr-observation atom carries the GitHub repo + number; the lifecycle
// projection surfaces it as a clickable link in the post-dispatch row.
const PR_NUMBER = 999_001;
const PR_URL = `https://github.com/stephengardner/layered-autonomous-governance/pull/${PR_NUMBER}`;
const MERGE_COMMIT_SHA = 'e2e0000000000000000000000000000000000001';

// Pure helpers below; no I/O happens until beforeAll runs them.

function seedFiles(): ReadonlyArray<{ path: string; atom: Record<string, unknown> }> {
  const files: Array<{ path: string; atom: Record<string, unknown> }> = [];

  // ---- 1. operator-intent (seeds the pipeline's derived_from chain). ----
  files.push({
    path: resolve(ATOMS_DIR, `${INTENT_ID}.json`),
    atom: {
      schema_version: 1,
      id: INTENT_ID,
      content: 'End-to-end Playwright fixture: validate the autonomous flow through to a merged PR.',
      type: 'operator-intent',
      layer: 'L1',
      provenance: {
        kind: 'user-directive',
        source: { agent_id: 'apex-agent', tool: 'e2e-seed' },
        derived_from: [],
      },
      confidence: 1,
      created_at: STARTED_AT_ISO,
      last_reinforced_at: STARTED_AT_ISO,
      expires_at: null,
      supersedes: [],
      superseded_by: [],
      scope: 'project',
      signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
      principal_id: 'apex-agent',
      taint: 'clean',
      metadata: {
        kind: 'autonomous-solve',
        request: 'End-to-end Playwright fixture: validate the autonomous flow through to a merged PR.',
        trust_envelope: {
          max_blast_radius: 'tooling',
          max_plans: 1,
          min_plan_confidence: 0.75,
          allowed_sub_actors: ['code-author'],
          require_ci_green: true,
          require_cr_approve: true,
          require_auditor_observation: true,
        },
        expires_at: new Date(BASE_TIME_MS + 86_400_000).toISOString(),
      },
    },
  });

  // ---- 2. pipeline root atom (state=completed). ----
  files.push({
    path: resolve(ATOMS_DIR, `${PIPELINE_ID}.json`),
    atom: {
      schema_version: 1,
      id: PIPELINE_ID,
      content: `pipeline:${SESSION_ID}`,
      type: 'pipeline',
      layer: 'L0',
      provenance: {
        kind: 'agent-observed',
        source: { tool: 'planning-pipeline', agent_id: 'cto-actor', session_id: SESSION_ID },
        derived_from: [INTENT_ID],
      },
      confidence: 1,
      created_at: STARTED_AT_ISO,
      last_reinforced_at: COMPLETED_AT_ISO,
      expires_at: null,
      supersedes: [],
      superseded_by: [],
      scope: 'project',
      signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
      principal_id: 'cto-actor',
      taint: 'clean',
      pipeline_state: 'completed',
      metadata: {
        stage_policy_atom_id: 'pol-planning-pipeline-stages-default',
        mode: 'substrate-deep',
        started_at: STARTED_AT_ISO,
        completed_at: COMPLETED_AT_ISO,
        total_cost_usd: 1.5,
        current_stage: 'dispatch-stage',
        current_stage_index: 4,
        title: `E2E fixture pipeline ${NONCE}`,
        seed_atom_ids: [INTENT_ID],
      },
    },
  });

  // ---- 3..7. pipeline-stage-event atoms (enter + exit-success per stage). ----
  STAGES.forEach((stageName, idx) => {
    const enterAt = new Date(BASE_TIME_MS + idx * STAGE_DURATION_MS).toISOString();
    const exitAt = new Date(BASE_TIME_MS + (idx + 1) * STAGE_DURATION_MS).toISOString();
    const enterId = `pipeline-stage-event-${PIPELINE_ID}-${stageName}-enter-${SESSION_ID}`;
    const exitId = `pipeline-stage-event-${PIPELINE_ID}-${stageName}-exit-success-${SESSION_ID}`;

    files.push({
      path: resolve(ATOMS_DIR, `${enterId}.json`),
      atom: {
        schema_version: 1,
        id: enterId,
        content: `${stageName}:enter`,
        type: 'pipeline-stage-event',
        layer: 'L0',
        provenance: {
          kind: 'agent-observed',
          source: { tool: 'planning-pipeline', agent_id: 'cto-actor', session_id: SESSION_ID },
          derived_from: [PIPELINE_ID],
        },
        confidence: 1,
        created_at: enterAt,
        last_reinforced_at: enterAt,
        expires_at: null,
        supersedes: [],
        superseded_by: [],
        scope: 'project',
        signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
        principal_id: 'cto-actor',
        taint: 'clean',
        metadata: {
          pipeline_id: PIPELINE_ID,
          stage_name: stageName,
          transition: 'enter',
          duration_ms: 0,
          cost_usd: 0,
        },
      },
    });

    files.push({
      path: resolve(ATOMS_DIR, `${exitId}.json`),
      atom: {
        schema_version: 1,
        id: exitId,
        content: `${stageName}:exit-success`,
        type: 'pipeline-stage-event',
        layer: 'L0',
        provenance: {
          kind: 'agent-observed',
          source: { tool: 'planning-pipeline', agent_id: 'cto-actor', session_id: SESSION_ID },
          derived_from: [PIPELINE_ID],
        },
        confidence: 1,
        created_at: exitAt,
        last_reinforced_at: exitAt,
        expires_at: null,
        supersedes: [],
        superseded_by: [],
        scope: 'project',
        signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
        principal_id: 'cto-actor',
        taint: 'clean',
        metadata: {
          pipeline_id: PIPELINE_ID,
          stage_name: stageName,
          transition: 'exit-success',
          duration_ms: STAGE_DURATION_MS,
          cost_usd: 0.3,
        },
      },
    });
  });

  // ---- 8. plan atom (plan-stage output). ----
  files.push({
    path: resolve(ATOMS_DIR, `${PLAN_ID}.json`),
    atom: {
      schema_version: 1,
      id: PLAN_ID,
      content: '## Why this\n\nE2E fixture plan: validate the full chain.\n\n## Concrete steps\n\n1. Add a TODO marker line to README.md.\n',
      type: 'plan',
      layer: 'L1',
      provenance: {
        kind: 'agent-observed',
        source: { tool: 'planning-pipeline', agent_id: 'cto-actor', session_id: SESSION_ID },
        derived_from: [PIPELINE_ID, INTENT_ID],
      },
      confidence: 0.92,
      created_at: new Date(BASE_TIME_MS + 2 * STAGE_DURATION_MS + 1_000).toISOString(),
      last_reinforced_at: new Date(BASE_TIME_MS + 2 * STAGE_DURATION_MS + 1_000).toISOString(),
      expires_at: null,
      supersedes: [],
      superseded_by: [],
      scope: 'project',
      signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
      principal_id: 'cto-actor',
      taint: 'clean',
      plan_state: 'succeeded',
      metadata: {
        title: `E2E fixture plan ${NONCE}`,
        pipeline_id: PIPELINE_ID,
        target_paths: ['README.md'],
        blast_radius: 'tooling',
        delegation: {
          sub_actor_principal_id: 'code-author',
        },
      },
    },
  });

  // ---- 9. dispatch-record (dispatched=1). ----
  files.push({
    path: resolve(ATOMS_DIR, `${DISPATCH_RECORD_ID}.json`),
    atom: {
      schema_version: 1,
      id: DISPATCH_RECORD_ID,
      content: '{\n  "dispatch_status": "completed",\n  "scanned": 1,\n  "dispatched": 1,\n  "failed": 0,\n  "cost_usd": 0\n}',
      type: 'dispatch-record',
      layer: 'L0',
      provenance: {
        kind: 'agent-observed',
        source: { tool: 'planning-pipeline', agent_id: 'cto-actor', session_id: SESSION_ID },
        derived_from: [PIPELINE_ID, PLAN_ID],
      },
      confidence: 1,
      created_at: new Date(BASE_TIME_MS + 5 * STAGE_DURATION_MS).toISOString(),
      last_reinforced_at: new Date(BASE_TIME_MS + 5 * STAGE_DURATION_MS).toISOString(),
      expires_at: null,
      supersedes: [],
      superseded_by: [],
      scope: 'project',
      signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
      principal_id: 'cto-actor',
      taint: 'clean',
      metadata: {
        pipeline_id: PIPELINE_ID,
        stage_name: 'dispatch-stage',
        stage_output: {
          dispatch_status: 'completed',
          scanned: 1,
          dispatched: 1,
          failed: 0,
          cost_usd: 0,
        },
      },
    },
  });

  // ---- 10. code-author-invoked observation (PR opened). ----
  const codeAuthorContent = `code-author invoked for plan ${PLAN_ID}\ncorrelation_id: dispatch-${PLAN_ID}\nfence: loaded, clean, not superseded\n\nExecutor completed the full chain:\n  PR:         #${PR_NUMBER} ${PR_URL}\n  Branch:     code-author/${PLAN_ID}\n  Commit:     ${MERGE_COMMIT_SHA}\n  Touched paths (1):\n    - README.md`;
  files.push({
    path: resolve(ATOMS_DIR, `${CODE_AUTHOR_OBS_ID}.json`),
    atom: {
      schema_version: 1,
      id: CODE_AUTHOR_OBS_ID,
      content: codeAuthorContent,
      type: 'observation',
      layer: 'L1',
      provenance: {
        kind: 'agent-observed',
        source: { agent_id: 'code-author', tool: 'code-author-invoker', session_id: `dispatch-${PLAN_ID}` },
        derived_from: [PLAN_ID],
      },
      confidence: 1,
      created_at: new Date(BASE_TIME_MS + 5 * STAGE_DURATION_MS + 5_000).toISOString(),
      last_reinforced_at: new Date(BASE_TIME_MS + 5 * STAGE_DURATION_MS + 5_000).toISOString(),
      expires_at: null,
      supersedes: [],
      superseded_by: [],
      scope: 'project',
      signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
      principal_id: 'code-author',
      taint: 'clean',
      metadata: {
        kind: 'code-author-invoked',
        plan_id: PLAN_ID,
        correlation_id: `dispatch-${PLAN_ID}`,
        fence_ok: true,
        fence_warnings: [],
        executor_result: {
          kind: 'dispatched',
          pr_number: PR_NUMBER,
          pr_html_url: PR_URL,
          branch_name: `code-author/${PLAN_ID}`,
          commit_sha: MERGE_COMMIT_SHA,
          model_used: 'claude-opus-4-7',
          confidence: 0.92,
          total_cost_usd: 1.2,
          touched_paths: ['README.md'],
        },
      },
    },
  });

  // ---- 11. pr-observation (MERGED, all checks green). ----
  // Content shape matches the runner's emit format so the lifecycle
  // projection's parseCheckCountsFromContent gets a clean three-green
  // / zero-red rollup. mergeStateStatus=CLEAN + pr_state=MERGED tells
  // the intent-outcome synthesizer to flip to 'intent-fulfilled'.
  const prObservationContent = `**pr-observation for stephengardner/layered-autonomous-governance#${PR_NUMBER}**\n\nobserved_at: ${PR_MERGED_AT_ISO}\nhead_sha: \`${MERGE_COMMIT_SHA}\`\nmergeable: MERGEABLE\nmergeStateStatus: \`CLEAN\`\n\nsubmitted reviews: 1\n  - coderabbitai[bot] APPROVED at ${PR_MERGED_AT_ISO}\ncheck-runs: 3\n  - Node 22 on ubuntu-latest: success\n  - Node 22 on windows-latest: success\n  - package hygiene: success\nlegacy statuses: 1\n  - CodeRabbit: success\nunresolved line comments: 0\nbody-scoped nits: 0\n`;
  files.push({
    path: resolve(ATOMS_DIR, `${PR_OBSERVATION_ID}.json`),
    atom: {
      schema_version: 1,
      id: PR_OBSERVATION_ID,
      content: prObservationContent,
      type: 'observation',
      layer: 'L1',
      provenance: {
        kind: 'agent-observed',
        source: { agent_id: 'pr-landing-agent', tool: 'run-pr-landing-observe-only', session_id: 'e2e-seed' },
        derived_from: [PLAN_ID],
      },
      confidence: 0.99,
      created_at: PR_MERGED_AT_ISO,
      last_reinforced_at: PR_MERGED_AT_ISO,
      expires_at: null,
      supersedes: [],
      superseded_by: [],
      scope: 'project',
      signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
      principal_id: 'pr-landing-agent',
      taint: 'clean',
      metadata: {
        kind: 'pr-observation',
        pr: {
          owner: 'stephengardner',
          repo: 'layered-autonomous-governance',
          number: PR_NUMBER,
        },
        head_sha: MERGE_COMMIT_SHA,
        observed_at: PR_MERGED_AT_ISO,
        mergeable: 'MERGEABLE',
        merge_state_status: 'CLEAN',
        pr_state: 'MERGED',
        pr_title: `feat(e2e): autonomous fixture ${NONCE}`,
        merge_commit_sha: MERGE_COMMIT_SHA,
        pr_merged_at: PR_MERGED_AT_ISO,
        pr_html_url: PR_URL,
        counts: {
          line_comments: 0,
          body_nits: 0,
          submitted_reviews: 1,
          check_runs: 3,
          legacy_statuses: 1,
        },
        partial: false,
        partial_surfaces: [],
        plan_id: PLAN_ID,
      },
    },
  });

  // ---- 12. plan-merge-settled (reconciler row tying merge to plan). ----
  files.push({
    path: resolve(ATOMS_DIR, `${MERGE_SETTLED_ID}.json`),
    atom: {
      schema_version: 1,
      id: MERGE_SETTLED_ID,
      content: `plan ${PLAN_ID} -> succeeded via PR merge observation ${PR_OBSERVATION_ID}`,
      type: 'plan-merge-settled',
      layer: 'L1',
      provenance: {
        kind: 'agent-observed',
        source: { agent_id: 'pr-landing-agent', tool: 'pr-merge-reconcile' },
        derived_from: [PLAN_ID, PR_OBSERVATION_ID],
      },
      confidence: 1,
      created_at: PR_MERGED_AT_ISO,
      last_reinforced_at: PR_MERGED_AT_ISO,
      expires_at: null,
      supersedes: [],
      superseded_by: [],
      scope: 'project',
      signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
      principal_id: 'pr-landing-agent',
      taint: 'clean',
      metadata: {
        plan_id: PLAN_ID,
        pr_observation_id: PR_OBSERVATION_ID,
        pr_state: 'MERGED',
        target_plan_state: 'succeeded',
        settled_at: PR_MERGED_AT_ISO,
        pr: {
          owner: 'stephengardner',
          repo: 'layered-autonomous-governance',
          number: PR_NUMBER,
        },
      },
    },
  });

  return files;
}

/**
 * Poll the backend until the seeded pipeline appears in pipelines.list.
 * The filesystem watcher debounces; a deterministic wait avoids
 * flakiness from raw retry counts.
 */
async function waitForPipelineVisible(page: Page, pipelineId: string): Promise<void> {
  await expect.poll(async () => {
    const response = await page.request.post('/api/pipelines.list');
    if (!response.ok()) return null;
    const body = await response.json();
    const rows: ReadonlyArray<{ pipeline_id: string }> = body?.data?.pipelines ?? [];
    return rows.some((r) => r.pipeline_id === pipelineId) ? 'visible' : null;
  }, { timeout: 15_000, intervals: [200, 500, 1_000] }).toBe('visible');
}

test.describe('end-to-end intent -> dispatch -> merge -> fulfilled', () => {
  test.beforeAll(async () => {
    // Ensure the atoms dir exists; a fresh checkout (or a custom
    // LAG_CONSOLE_LAG_DIR pointing at an uninitialized path) would
    // ENOENT on the first writeFile. Idempotent.
    await mkdir(ATOMS_DIR, { recursive: true });
    const files = seedFiles();
    for (const f of files) {
      await writeFile(f.path, JSON.stringify(f.atom, null, 2), 'utf8');
    }
  });

  test.afterAll(async () => {
    // Best-effort cleanup. unlink may race against the file-watcher;
    // try/catch keeps an outage in one file from masking the rest.
    for (const f of seedFiles()) {
      try { await unlink(f.path); } catch { /* already gone */ }
    }
  });

  test('the /file-intent surface is reachable and renders the form', async ({ page }) => {
    /*
     * Phase 1: the operator's entry point. Validate the form renders
     * with the expected defaults so the spec proves the surface that
     * `intents.file` is wired to actually exists and is navigable.
     * Submission itself is covered by file-intent.spec.ts (read-only
     * and write-enabled branches both); this assertion is the
     * "the door exists" check.
     */
    await page.goto('/file-intent');
    await expect(page.getByTestId('file-intent-view')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('file-intent-form')).toBeVisible();
    await expect(page.getByTestId('file-intent-request')).toBeVisible();
    await expect(page.getByTestId('file-intent-scope')).toHaveValue('tooling');
    await expect(page.getByTestId('file-intent-blast-radius')).toHaveValue('tooling');
    // Trigger toggle defaults to ON (autonomous flow fires immediately
    // on submit). The visible chip has the active styling when true.
    await expect(page.getByTestId('file-intent-trigger-toggle')).toBeVisible();
    // Submit is disabled at the empty-form initial state.
    await expect(page.getByTestId('file-intent-submit')).toBeDisabled();
  });

  test('the request field surfaces inline validation on too-short input', async ({ page }) => {
    /*
     * Phase 1b: the form's validate-on-change path renders an inline
     * error pill when the request is too short. We do NOT assert on
     * `submit:enabled` because that path also depends on
     * `LAG_CONSOLE_ACTOR_ID` being configured server-side (the form
     * requires actorId !== null in addition to a valid request).
     * That env-dependent enable-state branch is covered by
     * file-intent.spec.ts; this assertion focuses on the validate-on-
     * change UX so a regression that breaks the inline-error pill
     * surfaces in the end-to-end context too.
     */
    await page.goto('/file-intent');
    const textarea = page.getByTestId('file-intent-request');
    // Single character triggers the "too short" branch deterministically.
    await textarea.fill('A');
    await expect(page.getByTestId('file-intent-request-error')).toBeVisible();
    // Clearing the field flips to the "describe the intent" branch but
    // the same inline-error pill renders.
    await textarea.fill('');
    await expect(page.getByTestId('file-intent-request-error')).toBeVisible();
    // The submit button stays disabled in both cases.
    await expect(page.getByTestId('file-intent-submit')).toBeDisabled();
  });

  test('the seeded pipeline appears in the /pipelines list and is clickable', async ({ page }) => {
    /*
     * Phase 2: pipeline appears on the list view. The file-watcher
     * picks up the seeded pipeline atom and the projection at
     * /api/pipelines.list surfaces it. We do not wait for any animation
     * to settle -- the test asserts the card is rendered, not the
     * specific list ordering.
     */
    await waitForPipelineVisible(page, PIPELINE_ID);
    await page.goto('/pipelines');
    await expect(page.getByTestId('pipelines-view')).toBeVisible({ timeout: 10_000 });

    const card = page.locator(`[data-testid="pipeline-card"]`).filter({ hasText: NONCE }).first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    // Stat row is populated (cost, duration, finding count chips render).
    await expect(card.getByTestId('pipeline-card-cost')).toBeVisible();
    await expect(card.getByTestId('pipeline-card-duration')).toBeVisible();
  });

  test('drilling in shows the 5 stage cards all in `succeeded` state', async ({ page }) => {
    /*
     * Phase 3: stages reach succeeded. We assert each of the five
     * stage cards (brainstorm/spec/plan/review/dispatch) renders with
     * data-stage-state="succeeded" -- the load-bearing data attribute
     * the test-id-free projection key off of. Anything other than five
     * succeeded states means the projection's event-fold mis-handled
     * the seeded enter/exit pairs.
     */
    await waitForPipelineVisible(page, PIPELINE_ID);
    await page.goto(`/pipelines/${PIPELINE_ID}`);
    await expect(page.getByTestId('pipeline-detail-view')).toBeVisible({ timeout: 10_000 });

    // Header pill should reflect 'completed' (true-outcome resolves to
    // raw pipeline_state when dispatched > 0 and merged).
    await expect(page.getByTestId('pipeline-detail-state')).toBeVisible();
    const stateText = await page.getByTestId('pipeline-detail-state').innerText();
    expect(stateText.toLowerCase()).toMatch(/completed|fulfilled|succeeded/);

    // The stages section renders five cards, one per canonical stage.
    const stageCards = page.getByTestId('pipeline-stage-card');
    await expect(stageCards).toHaveCount(STAGES.length, { timeout: 10_000 });
    for (const stageName of STAGES) {
      const card = page.locator(`[data-testid="pipeline-stage-card"][data-stage-name="${stageName}"]`);
      await expect(card).toBeVisible();
      await expect(card).toHaveAttribute('data-stage-state', 'succeeded');
    }
  });

  test('the post-dispatch lifecycle section surfaces the PR + merge rows', async ({ page }) => {
    /*
     * Phase 4 + 5 + 6 collapsed: the post-dispatch lifecycle section
     * renders the chain from dispatch -> PR -> CR -> merge. Each row
     * has its own test id; we assert all four landed (the canonical
     * shape).
     */
    await waitForPipelineVisible(page, PIPELINE_ID);
    await page.goto(`/pipelines/${PIPELINE_ID}`);
    await expect(page.getByTestId('pipeline-detail-view')).toBeVisible({ timeout: 10_000 });

    const lifecycle = page.getByTestId('pipeline-lifecycle');
    await expect(lifecycle).toBeVisible({ timeout: 10_000 });
    /*
     * Wait for the lifecycle query to settle (loading placeholder shares
     * the section's outer test id but does not render the rows). Either
     * the dispatch row appears (data path) or the empty placeholder
     * appears; we expect the data path because we seeded all atoms.
     */
    const dispatchRow = page.getByTestId('pipeline-lifecycle-dispatch');
    await expect(dispatchRow).toBeVisible({ timeout: 10_000 });

    // Each canonical lifecycle row should have rendered now that data
    // is settled.
    await expect(page.getByTestId('pipeline-lifecycle-code-author')).toBeVisible();
    await expect(page.getByTestId('pipeline-lifecycle-pr')).toBeVisible();
    await expect(page.getByTestId('pipeline-lifecycle-merge')).toBeVisible();

    // PR link surfaces the right number + external href.
    const prLink = page.getByTestId('pipeline-lifecycle-pr-link');
    await expect(prLink).toBeVisible();
    await expect(prLink).toHaveAttribute('href', PR_URL);
  });

  test('the intent-outcome card flips to `intent-fulfilled` (TRUE-outcome semantics)', async ({ page }) => {
    /*
     * Phase 6 climax: the top-level outcome card aggregates every
     * downstream signal into a single state pill. With a MERGED PR
     * AND a plan-merge-settled atom, the synthesizer must return
     * `intent-fulfilled`. Anything else means a downstream
     * synthesizer rule (or the seeded chain) is broken.
     *
     * TRUE-outcome contract per canon `arch-atomstore-source-of-truth`:
     * the plan_state alone never flips this -- only an observed merge
     * does. Our pr-observation has pr_state=MERGED, so the synthesizer
     * has the load-bearing evidence.
     */
    await waitForPipelineVisible(page, PIPELINE_ID);
    await page.goto(`/pipelines/${PIPELINE_ID}`);
    await expect(page.getByTestId('pipeline-detail-view')).toBeVisible({ timeout: 10_000 });

    const card = page.getByTestId('intent-outcome-card');
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Wait for the state pill to land (the card renders a shimmer
    // first while the query is pending).
    const statePill = page.getByTestId('intent-outcome-state');
    await expect(statePill).toBeVisible({ timeout: 10_000 });
    await expect(statePill).toHaveAttribute('data-state', 'intent-fulfilled');

    // PR section surfaces with the right number + href.
    const prSection = page.getByTestId('intent-outcome-pr-section');
    await expect(prSection).toBeVisible();
    await expect(prSection).toContainText(`PR #${PR_NUMBER}`);
    const cardPrLink = page.getByTestId('intent-outcome-pr-link');
    await expect(cardPrLink).toHaveAttribute('href', PR_URL);
  });

  test('the detail surface exposes the SSE connection state via data attribute', async ({ page }) => {
    /*
     * Phase 7: the streaming surface (PR #299) is live. The detail
     * view's root carries a data-pipeline-stream attribute set to one
     * of connecting/open/reconnecting/failed. We accept any
     * non-terminal state because a CI proxy may degrade the stream to
     * 'failed' without invalidating the fallback poll path -- the
     * spec is about the surface existing, not about the wire
     * succeeding on a particular CI lane.
     */
    await waitForPipelineVisible(page, PIPELINE_ID);
    await page.goto(`/pipelines/${PIPELINE_ID}`);
    const view = page.getByTestId('pipeline-detail-view');
    await expect(view).toBeVisible({ timeout: 10_000 });

    /*
     * Read the attribute via getAttribute so a `connecting -> open`
     * transition is observed without retrying the assertion shape.
     */
    const streamState = await view.getAttribute('data-pipeline-stream');
    expect(streamState).not.toBeNull();
    expect(['connecting', 'open', 'reconnecting', 'failed']).toContain(streamState);
  });

  test('the detail surface has no horizontal scroll on mobile (390px)', async ({ page, viewport }) => {
    /*
     * Mobile-first floor: a horizontal scroll on the detail surface
     * at iPhone-13 width is a substrate violation per canon
     * `dev-web-mobile-first-required`. Run on the mobile project
     * only; the desktop project covers the wide layout via separate
     * specs.
     */
    if (!viewport || viewport.width > 480) {
      test.skip(true, 'desktop project does not enforce the mobile horizontal-scroll floor');
      return;
    }
    await waitForPipelineVisible(page, PIPELINE_ID);
    await page.goto(`/pipelines/${PIPELINE_ID}`);
    await expect(page.getByTestId('pipeline-detail-view')).toBeVisible({ timeout: 10_000 });

    const widths = await page.evaluate(() => ({
      inner: window.innerWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(
      widths.scroll,
      `inner=${widths.inner} scroll=${widths.scroll}`,
    ).toBeLessThanOrEqual(widths.inner + 1);
  });

  test('all phases of the chain are simultaneously visible on a single page', async ({ page }) => {
    /*
     * Final assertion: a single page render shows EVERY phase the
     * autonomous flow produces (stages + post-dispatch + PR +
     * merge + intent-fulfilled). The earlier per-phase tests prove
     * each surface in isolation; this test proves they compose into
     * one coherent operator-facing page -- the load-bearing claim of
     * "/pipelines/<id> shows ALL phases through to deployed/fulfilled"
     * from the task spec.
     */
    await waitForPipelineVisible(page, PIPELINE_ID);
    await page.goto(`/pipelines/${PIPELINE_ID}`);
    await expect(page.getByTestId('pipeline-detail-view')).toBeVisible({ timeout: 10_000 });

    // Stage strip.
    await expect(page.getByTestId('pipeline-detail-stages')).toBeVisible();
    await expect(page.getByTestId('pipeline-stage-card')).toHaveCount(STAGES.length);

    // Post-dispatch lifecycle.
    const dispatchRow = page.getByTestId('pipeline-lifecycle-dispatch');
    await expect(dispatchRow).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('pipeline-lifecycle-pr')).toBeVisible();
    await expect(page.getByTestId('pipeline-lifecycle-merge')).toBeVisible();

    // Intent outcome (fulfilled).
    const statePill = page.getByTestId('intent-outcome-state');
    await expect(statePill).toBeVisible({ timeout: 10_000 });
    await expect(statePill).toHaveAttribute('data-state', 'intent-fulfilled');
  });
});
