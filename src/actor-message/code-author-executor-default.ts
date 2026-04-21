/**
 * Default CodeAuthorExecutor: composes drafter + git-ops + pr-creation
 * into a single execute() call.
 *
 * This is the concrete implementation an on-premise consumer plugs in.
 * A different consumer (LangGraph-orchestrated, Temporal workflow, etc.)
 * can implement CodeAuthorExecutor against the same invoker without
 * importing these primitives.
 *
 * Stage map (each fails closed with a typed stage name on the error
 * return path so the observation atom records precisely where the
 * chain stopped):
 *   - drafter        LLM-backed diff generation
 *   - apply-branch   git fetch + apply + commit + push
 *   - pr-creation    GitHub pulls POST
 */

import { randomBytes } from 'node:crypto';
import type { execa } from 'execa';
import type { Atom } from '../types.js';
import type { Host } from '../interface.js';
import type { GhClient } from '../external/github/index.js';
import {
  draftCodeChange,
  DrafterError,
} from '../actors/code-author/drafter.js';
import {
  applyDraftBranch,
  GitOpsError,
  type GitIdentity,
} from '../actors/code-author/git-ops.js';
import {
  createDraftPr,
  renderPrBody,
  PrCreationError,
} from '../actors/code-author/pr-creation.js';
import type {
  CodeAuthorExecutor,
  CodeAuthorExecutorResult,
} from './code-author-invoker.js';

export interface DefaultExecutorConfig {
  readonly host: Host;
  readonly ghClient: GhClient;
  readonly owner: string;
  readonly repo: string;
  readonly repoDir: string;
  readonly gitIdentity: GitIdentity;
  readonly model: string;
  readonly branchPrefix?: string;
  readonly baseBranch?: string;
  readonly remote?: string;
  /** Draft PR by default; operator can flip this per deployment. */
  readonly draft?: boolean;
  /** Passed through to drafter as LlmOptions.disallowedTools. */
  readonly disallowedTools?: ReadonlyArray<string>;
  /**
   * Optional nonce generator. Overridable for deterministic tests;
   * default is 6 hex chars of crypto randomness.
   */
  readonly nonce?: () => string;
  /**
   * Execa override; forwarded to applyDraftBranch.execImpl. When
   * absent the real execa ships out subprocesses. Tests inject a
   * stub so no git subprocess runs.
   */
  readonly execImpl?: typeof execa;
}

export function buildDefaultCodeAuthorExecutor(
  config: DefaultExecutorConfig,
): CodeAuthorExecutor {
  const branchPrefix = config.branchPrefix ?? 'code-author/';
  const baseBranch = config.baseBranch ?? 'main';
  const remote = config.remote ?? 'origin';
  const draft = config.draft ?? true;
  const nonce = config.nonce ?? (() => randomBytes(3).toString('hex'));

  return {
    async execute(inputs): Promise<CodeAuthorExecutorResult> {
      const { plan, fence, correlationId, signal } = inputs;
      const planId = String(plan.id);
      const branchName = `${branchPrefix}${planId}-${nonce()}`;
      const meta = plan.metadata as Record<string, unknown>;
      const targetPaths = extractStringArray(meta, 'target_paths');
      const successCriteria = typeof meta['success_criteria'] === 'string'
        ? meta['success_criteria']
        : undefined;

      let draftResult;
      try {
        draftResult = await draftCodeChange(config.host, {
          plan,
          fence,
          targetPaths,
          model: config.model,
          ...(successCriteria !== undefined ? { successCriteria } : {}),
          ...(config.disallowedTools !== undefined ? { disallowedTools: config.disallowedTools } : {}),
          ...(signal !== undefined ? { signal } : {}),
        });
      } catch (err) {
        if (err instanceof DrafterError) {
          return {
            kind: 'error',
            stage: `drafter/${err.reason}`,
            reason: err.message,
          };
        }
        return {
          kind: 'error',
          stage: 'drafter/unexpected',
          reason: err instanceof Error ? err.message : String(err),
        };
      }

      let gitResult;
      try {
        gitResult = await applyDraftBranch({
          diff: draftResult.diff,
          repoDir: config.repoDir,
          branchName,
          baseBranch,
          commitMessage: buildCommitMessage(plan, draftResult.notes),
          authorIdentity: config.gitIdentity,
          stagePaths: draftResult.touchedPaths,
          remote,
          ...(signal !== undefined ? { signal } : {}),
          ...(config.execImpl !== undefined ? { execImpl: config.execImpl } : {}),
        });
      } catch (err) {
        if (err instanceof GitOpsError) {
          return {
            kind: 'error',
            stage: `apply-branch/${err.reason}`,
            reason: `${err.message} (stage=${err.stage})`,
          };
        }
        return {
          kind: 'error',
          stage: 'apply-branch/unexpected',
          reason: err instanceof Error ? err.message : String(err),
        };
      }

      const observationAtomId = planObservationAtomId(plan);

      let prResult;
      try {
        prResult = await createDraftPr({
          client: config.ghClient,
          owner: config.owner,
          repo: config.repo,
          title: buildPrTitle(plan),
          head: gitResult.branchName,
          base: baseBranch,
          body: renderPrBody({
            planId,
            planContent: String(plan.content),
            draftNotes: draftResult.notes,
            draftConfidence: draftResult.confidence,
            observationAtomId,
            commitSha: gitResult.commitSha,
            costUsd: draftResult.totalCostUsd,
            modelUsed: draftResult.modelUsed,
            touchedPaths: draftResult.touchedPaths,
          }),
          draft,
        });
      } catch (err) {
        if (err instanceof PrCreationError) {
          return {
            kind: 'error',
            stage: `pr-creation/${err.reason}`,
            reason: `${err.message} (stage=${err.stage})`,
          };
        }
        return {
          kind: 'error',
          stage: 'pr-creation/unexpected',
          reason: err instanceof Error ? err.message : String(err),
        };
      }

      // correlationId is currently unused inside the chain; the invoker
      // records it on the observation atom. Preserved in scope to keep
      // the interface contract stable as future chain steps (e.g., a
      // `code-author-started` atom before the drafter call) begin to
      // consume it.
      void correlationId;

      return {
        kind: 'dispatched',
        prNumber: prResult.number,
        prHtmlUrl: prResult.htmlUrl,
        branchName: gitResult.branchName,
        commitSha: gitResult.commitSha,
        totalCostUsd: draftResult.totalCostUsd,
        modelUsed: draftResult.modelUsed,
        confidence: draftResult.confidence,
        touchedPaths: draftResult.touchedPaths,
      };
    },
  };
}

function extractStringArray(
  meta: Record<string, unknown>,
  key: string,
): ReadonlyArray<string> {
  const v = meta[key];
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string' && item.length > 0) out.push(item);
  }
  return out;
}

function buildPrTitle(plan: Atom): string {
  const meta = plan.metadata as Record<string, unknown>;
  const title = typeof meta['title'] === 'string' && meta['title'].length > 0
    ? meta['title']
    : `plan ${plan.id}`;
  return `code-author: ${title}`;
}

function buildCommitMessage(plan: Atom, draftNotes: string): string {
  const title = buildPrTitle(plan);
  const body = draftNotes.trim();
  return body.length > 0 ? `${title}\n\n${body}` : title;
}

function planObservationAtomId(plan: Atom): string {
  // The real id is constructed by the invoker at observation-write
  // time. The body-render path needs a stable reference string for the
  // YAML footer; use the plan id as the correlation anchor. When the
  // invoker lands, the rendered body + the final atom id are co-located
  // on the same observation.
  return `code-author-invoked-${String(plan.id)}`;
}
