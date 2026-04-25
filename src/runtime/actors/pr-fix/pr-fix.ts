/**
 * PrFixActor: an outward Actor that drives a PR through review-feedback
 * fix iterations via the agent-loop substrate seam.
 *
 * Loop (this task ships only `observe`; the rest land in subsequent tasks):
 *   observe  -> read PR review status (line comments + body nits + checks +
 *               legacy statuses + mergeable flag) and the PR head ref/SHA;
 *               write a generic `observation` atom (with
 *               `metadata.kind: 'pr-fix-observation'`) that captures the
 *               snapshot and chains via `provenance.derived_from` to the
 *               prior observation for the same PR.
 *   classify -> partition findings, detect convergence, propagate `partial`.
 *   propose  -> delegate fixes to an agent-loop run, or escalate.
 *   apply    -> dispatch the agent-loop run and verify the resulting commit.
 *   reflect  -> halt when the PR is clean or escalation has happened.
 *
 * This module stays mechanism-only: it does not name specific actor
 * instances or canon ids. The atom shape lives in `../../../substrate/types.js`
 * and the atom builder in `./pr-fix-observation.js`; this actor only
 * orchestrates them.
 */

import { randomBytes } from 'node:crypto';
import { execa } from 'execa';
import type { Actor, ActorContext } from '../actor.js';
import type { Classified, ProposedAction, Reflection } from '../types.js';
import type { AtomId, ReplayTier, Time } from '../../../substrate/types.js';
import type { PrIdentifier, ReviewComment } from '../pr-review/adapter.js';
import type {
  AgentLoopResult,
  AgentTask,
} from '../../../substrate/agent-loop.js';
import type { Workspace } from '../../../substrate/workspace-provider.js';
import { defaultBudgetCap, type BudgetCap } from '../../../substrate/agent-budget.js';
import { loadReplayTier } from '../../../substrate/policy/replay-tier.js';
import { loadBlobThreshold } from '../../../substrate/policy/blob-threshold.js';
import { sendOperatorEscalation } from '../../actor-message/index.js';
import type { ActorReport } from '../types.js';
import type {
  PrFixObservation,
  PrFixAction,
  PrFixOutcome,
  PrFixAdapters,
  PrFixClassification,
  PrFixObservationMeta,
} from './types.js';
import { mkPrFixObservationAtom, mkPrFixObservationAtomId } from './pr-fix-observation.js';

export interface PrFixOptions {
  readonly pr: PrIdentifier;
  /**
   * Optional clock injection point for deterministic tests. Defaults to
   * `() => new Date().toISOString()`.
   */
  readonly now?: () => string;
  /**
   * Used by the policy resolvers (`loadReplayTier`, `loadBlobThreshold`)
   * to look up per-actor-type policy atoms. Defaults to `'pr-fix-actor'`.
   */
  readonly actorType?: string;
  /**
   * Budget cap forwarded to the agent-loop subagent. Defaults to
   * `defaultBudgetCap()`. Operators override per-deployment via the
   * driver script.
   */
  readonly budget?: BudgetCap;
  /**
   * Tools to disallow in the subagent BEYOND the floor (`WebFetch`,
   * `WebSearch`, `NotebookEdit`). Operators add diagnostic-only flags
   * (e.g. `['Bash']` for read-only runs) here without unsafely
   * narrowing the substrate floor.
   */
  readonly additionalDisallowedTools?: ReadonlyArray<string>;
  /**
   * Test-only override for the workspace HEAD reader. Defaults to
   * `git rev-parse HEAD` via `execa`. The production path always uses
   * the default; this seam exists so tests can drive SHA mismatch and
   * SHA match scenarios without touching real git.
   */
  readonly readWorkspaceHeadSha?: (workspacePath: string) => Promise<string>;
  /**
   * Test-only override for the touched-paths reader. Defaults to
   * `git diff --name-only <baseRef>..HEAD` via `execa`. Same rationale
   * as `readWorkspaceHeadSha`.
   */
  readonly readTouchedPaths?: (workspacePath: string, baseRef: string) => Promise<ReadonlySet<string>>;
}

/**
 * Layer-B sub-agent disallowedTools floor. Mirrors the spec's §3.4
 * Layer-B contract: the spawned Claude inside the workspace MUST NOT
 * call these tools regardless of operator config; operator extension
 * is additive (see `PrFixOptions.additionalDisallowedTools`).
 *
 * - WebFetch / WebSearch: agent runs with the bot's GitHub creds; deny
 *   external IO so a prompt-injection finding cannot exfil.
 * - NotebookEdit: .ipynb editing is not a CR-fix concern in scope.
 *
 * Stronger guards (push-target restriction, secret-shape redaction)
 * live in WorkspaceProvider's cred provisioning + the Redactor seam;
 * this constant is one layer of the defense-in-depth stack.
 */
const SUB_AGENT_DISALLOWED_FLOOR: ReadonlyArray<string> = ['WebFetch', 'WebSearch', 'NotebookEdit'];

/**
 * Default workspace HEAD reader. Wraps `git rev-parse HEAD` via
 * `execa`. Trims trailing newline. Throws on a non-zero exit so the
 * caller maps the failure onto a `fix-failed` stage.
 */
async function readWorkspaceHeadShaDefault(workspacePath: string): Promise<string> {
  const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: workspacePath });
  return stdout.trim();
}

/**
 * Default touched-paths reader. Wraps `git diff --name-only
 * <baseRef>..HEAD` via `execa`. Empty stdout (no diff) yields the
 * empty set. Throws on a non-zero exit; the caller treats a read
 * failure as "no resolvable threads this iteration" rather than
 * masking the upstream success.
 */
async function readTouchedPathsDefault(workspacePath: string, baseRef: string): Promise<ReadonlySet<string>> {
  const { stdout } = await execa('git', ['diff', '--name-only', `${baseRef}..HEAD`], { cwd: workspacePath });
  return new Set(stdout.split('\n').map((s) => s.trim()).filter((s) => s.length > 0));
}

/**
 * Build the agent's questionPrompt from a list of CR findings. Each
 * finding gets a fenced `<cr_finding>` block so the agent can parse
 * structure rather than scrape prose. Includes the headBranch so the
 * agent knows it is operating on the PR's existing branch (no new
 * branch creation expected).
 *
 * This function does NOT pre-redact: the AgentLoopAdapter applies
 * `input.redactor` before atom write per the substrate contract. A
 * redaction pass here would either duplicate work (idempotent
 * redactor) or, worse, run before the substrate-mandated step and let
 * a non-default redactor be bypassed.
 */
function buildQuestionPrompt(
  findings: ReadonlyArray<ReviewComment>,
  headBranch: string,
): string {
  const blocks = findings.map((f, i) => {
    const path = f.path ?? '<unknown-path>';
    const line = f.line !== undefined ? `:${f.line}` : '';
    return `<cr_finding index="${i + 1}" id="${f.id}" path="${path}${line}">\n${f.body}\n</cr_finding>`;
  }).join('\n\n');
  return (
    `You are running on branch '${headBranch}', the HEAD of an open pull request. ` +
    `Address the CodeRabbit review findings below by editing files in this workspace, ` +
    `committing the changes, and pushing to update the PR. Do NOT create new branches; ` +
    `the PR already exists. After your fix, run the project's tests to verify nothing regresses.\n\n` +
    blocks
  );
}

/**
 * Dedupe path strings across a finding set; drops findings without a
 * path (body-nits without a target file). Order is insertion-stable
 * over the input array.
 */
function dedupePaths(findings: ReadonlyArray<ReviewComment>): ReadonlyArray<string> {
  const set = new Set<string>();
  for (const f of findings) if (f.path !== undefined) set.add(f.path);
  return [...set];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const defaultNow = (): string => new Date().toISOString();

export class PrFixActor implements Actor<
  PrFixObservation,
  PrFixAction,
  PrFixOutcome,
  PrFixAdapters
> {
  readonly name = 'pr-fix-actor';
  readonly version = '1';

  private lastObservationId: AtomId | undefined;
  private lastObservation: PrFixObservation | undefined;
  /**
   * Resolved at construction so policy lookups + atom-store writes share
   * one stable string. Defaults to `'pr-fix-actor'` (the actor's own
   * `name`); operators override per deployment via `options.actorType`
   * when running multiple flavor-specific instances.
   */
  private readonly actorType: string;

  constructor(private readonly options: PrFixOptions) {
    this.actorType = options.actorType ?? 'pr-fix-actor';
  }

  async observe(ctx: ActorContext<PrFixAdapters>): Promise<PrFixObservation> {
    const { review, ghClient } = ctx.adapters;
    const status = await review.getPrReviewStatus(this.options.pr);

    const prDetails = await ghClient.rest<{
      head: { ref: string; sha: string };
      base: { ref: string };
    }>({
      path: `repos/${this.options.pr.owner}/${this.options.pr.repo}/pulls/${this.options.pr.number}`,
      signal: ctx.abortSignal,
    });
    if (prDetails === undefined) {
      throw new Error(
        `pulls.get returned no body for ${this.options.pr.owner}/${this.options.pr.repo}#${this.options.pr.number}`,
      );
    }

    const obsId = mkPrFixObservationAtomId();
    const meta: PrFixObservationMeta = {
      pr_owner: this.options.pr.owner,
      pr_repo: this.options.pr.repo,
      pr_number: this.options.pr.number,
      head_branch: prDetails.head.ref,
      head_sha: prDetails.head.sha,
      cr_review_states: status.submittedReviews.map((r) => ({
        author: r.author,
        state: r.state,
        submitted_at: r.submittedAt,
      })),
      merge_state_status: status.mergeStateStatus,
      mergeable: status.mergeable,
      line_comment_count: status.lineComments.length,
      body_nit_count: status.bodyNits.length,
      check_run_failure_count: status.checkRuns.filter(
        (c) => c.status === 'completed' && c.conclusion === 'failure',
      ).length,
      legacy_status_failure_count: status.legacyStatuses.filter(
        (s) => s.state === 'failure' || s.state === 'error',
      ).length,
      partial: status.partial,
      // Placeholder; classify() patches this in metadata after observe runs.
      classification: 'has-findings',
    };

    const now = (this.options.now ?? defaultNow)();
    const atom = mkPrFixObservationAtom({
      principal: ctx.principal.id,
      observationId: obsId,
      meta,
      priorObservationAtomId: this.lastObservationId,
      dispatchedSessionAtomId: undefined,
      now,
    });
    await ctx.host.atoms.put(atom);
    this.lastObservationId = obsId;

    const observation: PrFixObservation = {
      pr: this.options.pr,
      headBranch: prDetails.head.ref,
      headSha: prDetails.head.sha,
      baseRef: prDetails.base.ref,
      lineComments: status.lineComments,
      bodyNits: status.bodyNits,
      submittedReviews: status.submittedReviews,
      checkRuns: status.checkRuns,
      legacyStatuses: status.legacyStatuses,
      mergeStateStatus: status.mergeStateStatus,
      mergeable: status.mergeable,
      partial: status.partial,
      observationAtomId: obsId,
    };
    // Cached so apply() can recover baseRef + pr-identity + headSha
    // without re-fetching; runActor calls observe before each apply,
    // so this is always the freshest snapshot for this actor instance.
    this.lastObservation = observation;
    return observation;
  }

  // The remaining lifecycle methods are filled in by subsequent tasks.

  /**
   * Map a `PrFixObservation` to one of the five `PrFixClassification`
   * literals and a convergence key. The key uses interpolated numeric
   * counts so two consecutive iterations with identical PR state
   * produce identical keys; runActor halts on key-equality with
   * `progress: false`. `obs.partial === true` short-circuits to
   * `'partial'` with a fixed key (the do-not-decide signal).
   */
  async classify(
    obs: PrFixObservation,
    ctx: ActorContext<PrFixAdapters>,
  ): Promise<Classified<PrFixObservation>> {
    let classification: PrFixClassification;
    let ciFailures = 0;
    let arch = 0;
    let key: string;
    if (obs.partial) {
      classification = 'partial';
      key = 'pr-fix:partial=true';
    } else {
      ciFailures = countCiFailures(obs);
      arch = countArchitectural(obs);
      const totalFindings = obs.lineComments.length + obs.bodyNits.length;
      key = `pr-fix:lineN=${obs.lineComments.length}:bodyN=${obs.bodyNits.length}:cr=${summarizeReviewState(obs.submittedReviews)}:ci=${ciFailures}:arch=${arch}`;
      if (totalFindings === 0 && ciFailures === 0 && obs.mergeStateStatus !== 'BEHIND') {
        classification = 'all-clean';
      } else if (ciFailures > 0) {
        classification = 'ci-failure';
      } else if (arch > 0) {
        classification = 'architectural';
      } else {
        classification = 'has-findings';
      }
    }

    // Patch the observation atom's stored classification with the real
    // value computed here. observe() writes a placeholder
    // 'has-findings' so the atom always has a discriminator field; the
    // real classification is only known after this method runs. Without
    // this patch, every persisted observation atom would read as
    // 'has-findings' regardless of the actual outcome (clean / ci /
    // architectural / partial), breaking forensic re-reads of the
    // observation history. AtomStore.update() shallow-merges metadata
    // by top-level key, so we read the existing pr_fix_observation
    // sub-object and merge the classification field explicitly to
    // avoid clobbering sibling fields like dispatched_session_atom_id
    // (which apply() may have already patched on a prior iteration).
    try {
      const existing = await ctx.host.atoms.get(obs.observationAtomId);
      if (existing !== null) {
        const prevPrFix = (existing.metadata as { pr_fix_observation?: PrFixObservationMeta }).pr_fix_observation;
        if (prevPrFix !== undefined && prevPrFix.classification !== classification) {
          await ctx.host.atoms.update(obs.observationAtomId, {
            metadata: {
              pr_fix_observation: { ...prevPrFix, classification },
            },
          });
        }
      }
    } catch {
      // Patch failure is non-fatal: classify still returned the real
      // value, the loop progresses, and the next observe() writes a
      // fresh atom. Swallowing here prevents a transient store error
      // from masking the upstream success of computing the real
      // classification.
    }

    return {
      observation: obs,
      key,
      metadata: { classification, ciFailures, arch },
    };
  }

  /**
   * Map a `Classified<PrFixObservation>` to zero or one `ProposedAction`s.
   *
   * Action mapping (each `tool` literal MUST match the corresponding policy
   * atom name; a typo silently disables the policy gate):
   *   - 'all-clean'    -> []  (loop ends naturally)
   *   - 'partial'      -> []  (do-not-decide; let next iteration retry observe)
   *   - 'has-findings' -> one `agent-loop-dispatch` action carrying the
   *                       union of `lineComments` + `bodyNits` as findings,
   *                       a freshly-minted plan-atom id (mintPlanAtomId;
   *                       written to the store later by apply), and the
   *                       PR's HEAD branch (workspace pins to it).
   *   - 'ci-failure'   -> one `pr-escalate` action with a 'CI failure: ...'
   *                       reason listing the failed run / status names.
   *   - 'architectural'-> one `pr-escalate` action with an
   *                       'Architectural concern: ...' reason citing the
   *                       first matching comment id + the first 200 chars
   *                       of its first line.
   *
   * Defensive: when `classified.metadata` is undefined (classify did not
   * populate it), return [] rather than throwing. This keeps the loop
   * progressing one more iteration where classify will re-run and either
   * fix the metadata or surface the underlying issue.
   */
  async propose(
    classified: Classified<PrFixObservation>,
    _ctx: ActorContext<PrFixAdapters>,
  ): Promise<ReadonlyArray<ProposedAction<PrFixAction>>> {
    const meta = classified.metadata as
      | { classification: PrFixClassification; ciFailures: number; arch: number }
      | undefined;
    if (meta === undefined) return [];
    const obs = classified.observation;
    const classification = meta.classification;

    switch (classification) {
      case 'all-clean':
      case 'partial':
        return [];
      case 'has-findings': {
        const findings = [...obs.lineComments, ...obs.bodyNits];
        const planAtomId = mintPlanAtomId();
        return [{
          tool: 'agent-loop-dispatch',
          description: `Dispatch agent loop to address ${findings.length} unresolved finding(s) on PR ${obs.pr.owner}/${obs.pr.repo}#${obs.pr.number}`,
          payload: {
            kind: 'agent-loop-dispatch',
            findings,
            planAtomId,
            headBranch: obs.headBranch,
          },
        }];
      }
      case 'ci-failure':
        return [{
          tool: 'pr-escalate',
          description: `Escalate CI failure on PR ${obs.pr.owner}/${obs.pr.repo}#${obs.pr.number}`,
          payload: {
            kind: 'pr-escalate',
            reason: `CI failure: ${describeCiFailures(obs)}`,
          },
        }];
      case 'architectural':
        return [{
          tool: 'pr-escalate',
          description: `Escalate architectural concern on PR ${obs.pr.owner}/${obs.pr.repo}#${obs.pr.number}`,
          payload: {
            kind: 'pr-escalate',
            reason: `Architectural concern: ${describeArchitectural(obs)}`,
          },
        }];
    }
  }

  /**
   * Drive a single proposed action to an outcome.
   *
   * Two branches keyed off `action.payload.kind`:
   *   - `'agent-loop-dispatch'`: acquire a workspace pinned to the PR's
   *     HEAD branch, run the agent-loop substrate, verify the
   *     adapter-supplied commit-SHA against `git rev-parse HEAD`, then
   *     resolve threads on touched paths only.
   *   - `'pr-escalate'`: deferred to Task 10. Throws today.
   *
   * Substrate-mandated steps (per the AgentLoopAdapter contract):
   *   1. Compose `replayTier` + `blobThreshold` from per-actor-type
   *      policy atoms (fail-loud on malformed; default on missing).
   *   2. Acquire workspace through the WorkspaceProvider with
   *      `checkoutBranch: action.headBranch` (substrate extension).
   *   3. Run the agent-loop with the Layer-B disallowedTools floor +
   *      operator extension.
   *   4. Verify `result.artifacts.commitSha` equals workspace HEAD
   *      (defense against a misbehaving adapter that fabricates a SHA).
   *   5. Resolve CR threads ONLY for findings whose path is in the
   *      touched-paths set AND whose kind is not 'body-nit' (body-nits
   *      cannot be resolved individually).
   *   6. Always release the workspace in `finally{}`. Release errors
   *      are swallowed: a release failure must not mask the upstream
   *      result.
   */
  async apply(
    action: ProposedAction<PrFixAction>,
    ctx: ActorContext<PrFixAdapters>,
  ): Promise<PrFixOutcome> {
    if (action.payload.kind === 'pr-escalate') {
      const reason = action.payload.reason;
      const obs = this.lastObservation;
      // Best-effort path: if observe has not run yet (or did not complete),
      // we can still surface the halt to runActor's reflect via the
      // Outcome. The escalation atom would otherwise lack the PR
      // identifier the helper expects, so skip the side-effect rather
      // than synthesize a half-baked context.
      if (obs === undefined) {
        return { kind: 'escalated', reason };
      }
      const nowIso = (this.options.now ?? defaultNow)() as Time;
      // Synthesize an ActorReport for the helper's context. PrFixActor's
      // apply is mid-iteration (runActor has not yet halted from its own
      // POV); we use the haltReason 'policy-escalate-blocking' so the
      // escalation atom carries the intent semantically. The reflect
      // method (Task 11) translates this Outcome into runActor's halt.
      const synthReport: ActorReport = {
        actor: this.name,
        principal: ctx.principal.id,
        haltReason: 'policy-escalate-blocking',
        iterations: ctx.iteration,
        startedAt: nowIso,
        endedAt: nowIso,
        escalations: [reason],
        lastNote: reason,
      };
      try {
        await sendOperatorEscalation({
          host: ctx.host,
          report: synthReport,
          pr: { owner: obs.pr.owner, repo: obs.pr.repo, number: obs.pr.number },
          observation: { comments: obs.lineComments, bodyNits: obs.bodyNits },
          origin: 'pr-fix-actor',
        });
      } catch {
        // A delivery failure must not block the actor's halt path. The
        // operator-message atom may have failed to write (storage error,
        // dedup-conflict beyond the helper's ConflictError swallow,
        // etc.); the actor still returns 'escalated' so reflect halts
        // and the operator sees the escalation via the PR's existing
        // CR thread regardless.
      }
      return { kind: 'escalated', reason };
    }
    const dispatch = action.payload;
    const obs = this.lastObservation;
    if (obs === undefined) {
      return {
        kind: 'fix-failed',
        stage: 'no-observation',
        reason: 'apply called before observe',
        sessionAtomId: null,
      };
    }

    const correlationId = `pr-fix:${obs.pr.owner}/${obs.pr.repo}#${obs.pr.number}:${obs.headSha.slice(0, 12)}:${randomBytes(3).toString('hex')}`;

    // 1. Resolve per-actor-type substrate policies. Malformed atoms
    // fail loud; missing atoms fall back to substrate defaults.
    let replayTier: ReplayTier;
    let blobThreshold: number;
    try {
      replayTier = await loadReplayTier(ctx.host.atoms, ctx.principal.id, this.actorType);
      blobThreshold = await loadBlobThreshold(ctx.host.atoms, ctx.principal.id, this.actorType);
    } catch (err) {
      return {
        kind: 'fix-failed',
        stage: 'policy-resolution',
        reason: errorMessage(err),
        sessionAtomId: null,
      };
    }

    // 2. Acquire workspace pinned to the PR's HEAD branch (substrate
    // extension shipped in Task 1; provider checks out the branch
    // directly so commits land on it).
    let workspace: Workspace;
    try {
      workspace = await ctx.adapters.workspaceProvider.acquire({
        principal: ctx.principal.id,
        baseRef: obs.baseRef,
        checkoutBranch: dispatch.headBranch,
        correlationId,
      });
    } catch (err) {
      return {
        kind: 'fix-failed',
        stage: 'workspace-acquire',
        reason: errorMessage(err),
        sessionAtomId: null,
      };
    }

    try {
      // 3. Compose the AgentTask + budget + tool policy.
      const task: AgentTask = {
        planAtomId: dispatch.planAtomId,
        questionPrompt: buildQuestionPrompt(dispatch.findings, dispatch.headBranch),
        targetPaths: dedupePaths(dispatch.findings),
      };
      const budget = this.options.budget ?? defaultBudgetCap();
      const disallowedTools: ReadonlyArray<string> = [
        ...SUB_AGENT_DISALLOWED_FLOOR,
        ...(this.options.additionalDisallowedTools ?? []),
      ];

      // 4. Run the agent-loop. Adapter is the substrate primitive that
      // owns LLM IO + tool dispatch; this actor never reaches around it.
      let agentResult: AgentLoopResult;
      try {
        agentResult = await ctx.adapters.agentLoop.run({
          host: ctx.host,
          principal: ctx.principal.id,
          workspace,
          task,
          budget,
          toolPolicy: { disallowedTools },
          redactor: ctx.adapters.redactor,
          blobStore: ctx.adapters.blobStore,
          replayTier,
          blobThreshold,
          correlationId,
          signal: ctx.abortSignal,
        });
      } catch (err) {
        const kind = ctx.adapters.agentLoop.capabilities.classify_failure(err);
        return {
          kind: 'fix-failed',
          stage: `agent-loop-throw/${kind}`,
          reason: errorMessage(err),
          sessionAtomId: null,
        };
      }

      // 5a. Cooperative abort short-circuits the actor. The substrate's
      // 'aborted' kind covers kill-switch, deadline, caller cancellation;
      // those signals are not no-progress iterations and must not feed
      // convergence handling. Throwing an AbortError unwinds through
      // runActor's kill-switch path so the actor halts immediately
      // rather than landing as fix-failed and triggering another
      // iteration of observe -> classify -> propose.
      if (agentResult.kind === 'aborted') {
        const err = new Error('agent loop aborted');
        err.name = 'AbortError';
        throw err;
      }

      // 5b. Map non-aborted, non-completed kinds. The substrate
      // vocabulary is one word away from the dashboard contract; the
      // stage shape is `agent-loop/<kind>[/<failure-kind>]`.
      if (agentResult.kind !== 'completed') {
        const stage = agentResult.failure
          ? `agent-loop/${agentResult.kind}/${agentResult.failure.kind}`
          : `agent-loop/${agentResult.kind}`;
        const reason = agentResult.failure?.reason ?? `agent loop ended in ${agentResult.kind}`;
        return {
          kind: 'fix-failed',
          stage,
          reason,
          sessionAtomId: agentResult.sessionAtomId,
        };
      }

      // 6. Substrate-mandated commit-SHA verification. The agent-loop
      // contract states "consumers MUST verify the commit exists in
      // the workspace before trusting it"; this is the load-bearing
      // step that prevents a misbehaving adapter from claiming a fix
      // landed when none did.
      const commitSha = agentResult.artifacts?.commitSha;
      if (commitSha === undefined) {
        return {
          kind: 'fix-failed',
          stage: 'agent-no-commit',
          reason: 'agent loop completed but did not commit',
          sessionAtomId: agentResult.sessionAtomId,
        };
      }
      const readHead = this.options.readWorkspaceHeadSha ?? readWorkspaceHeadShaDefault;
      let workspaceHead: string;
      try {
        workspaceHead = await readHead(workspace.path);
      } catch (err) {
        return {
          kind: 'fix-failed',
          stage: 'rev-parse-failed',
          reason: errorMessage(err),
          sessionAtomId: agentResult.sessionAtomId,
        };
      }
      if (workspaceHead !== commitSha) {
        return {
          kind: 'fix-failed',
          stage: 'verify-commit-sha',
          reason: `adapter-supplied SHA ${commitSha} does not match HEAD ${workspaceHead}`,
          sessionAtomId: agentResult.sessionAtomId,
        };
      }

      // 7. Touched-paths heuristic for thread resolution. A read
      // failure is non-fatal: the commit already landed and CR's
      // re-review is the ground truth on the next iteration.
      const readPaths = this.options.readTouchedPaths ?? readTouchedPathsDefault;
      let touched: ReadonlySet<string>;
      try {
        touched = await readPaths(workspace.path, obs.baseRef);
      } catch {
        touched = new Set();
      }

      // 8. Resolve CR threads addressed by the fix. Body-nits cannot
      // be resolved individually (they live inside a single review
      // body); findings whose path was not touched are definitionally
      // not addressed by this iteration. Resolve failures for one
      // thread do not block the others; the next iteration's observe
      // re-checks any unresolved comments.
      const resolvedCommentIds: string[] = [];
      for (const f of dispatch.findings) {
        if (f.kind === 'body-nit') continue;
        if (f.path === undefined) continue;
        if (!touched.has(f.path)) continue;
        try {
          await ctx.adapters.review.resolveComment(obs.pr, f.id);
          resolvedCommentIds.push(f.id);
        } catch {
          // Per spec §5: log + skip. The fix landed; the thread state
          // is recoverable manually. Audit recording happens via the
          // review adapter's own logging; do not surface here as a
          // hard fail.
        }
      }

      // Patch the observation atom with the dispatched session id so
      // the audit trail chains observation -> session -> turn atoms.
      // Same shallow-merge note as in classify(): we read the existing
      // pr_fix_observation sub-object and merge the new field
      // explicitly, otherwise sibling fields (classification etc.)
      // would clobber on the patch. Patch failure is non-fatal: the
      // chain pointer is a forensic convenience, not a correctness
      // primitive (sessionAtomId is also returned in the Outcome).
      try {
        const existing = await ctx.host.atoms.get(obs.observationAtomId);
        if (existing !== null) {
          const prevPrFix = (existing.metadata as { pr_fix_observation?: PrFixObservationMeta }).pr_fix_observation;
          if (prevPrFix !== undefined) {
            await ctx.host.atoms.update(obs.observationAtomId, {
              metadata: {
                pr_fix_observation: {
                  ...prevPrFix,
                  dispatched_session_atom_id: agentResult.sessionAtomId,
                },
              },
            });
          }
        }
      } catch {
        // See classify() rationale: a transient store error here must
        // not mask the upstream fix-pushed outcome.
      }

      return {
        kind: 'fix-pushed',
        commitSha,
        resolvedCommentIds,
        sessionAtomId: agentResult.sessionAtomId,
      };
    } finally {
      // Release runs even when the agent-loop adapter throws or the
      // SHA check fails. Errors are swallowed: a release failure must
      // not mask the upstream result. Idempotent by contract.
      await ctx.adapters.workspaceProvider.release(workspace).catch(() => undefined);
    }
  }

  /**
   * Map an iteration's outcomes + classification to a `Reflection`.
   *
   * Classification short-circuits drive the no-action branches first;
   * outcome inspection drives the post-apply branches. The outcome
   * priority chain is `escalated` > `fix-failed` > `fix-pushed`: a
   * single escalated outcome halts the loop regardless of any sibling
   * fix-pushed in the same iteration (defense in depth -- a misbehaving
   * propose path could theoretically emit both, and escalation wins).
   *
   * Outcome -> Reflection table:
   *   - classification 'all-clean'      -> {done:true,  progress:false, note:'all clean; nothing to fix'}
   *   - classification 'partial'        -> {done:false, progress:false, note:'partial observation; retrying'}
   *   - any outcome.kind === 'escalated' -> {done:true,  progress:false, note: outcome.reason}
   *   - any outcome.kind === 'fix-failed' (no escalated) -> {done:false, progress:false, note: outcome.reason}
   *   - any outcome.kind === 'fix-pushed' (no escalated, no failed)
   *                                       -> {done:false, progress:true,  note:'fix pushed; reobserving'}
   *   - empty outcomes + non-terminal classification (defensive)
   *                                       -> {done:false, progress:false, note:'no progress'}
   *
   * The `progress: false` flag on the `no progress` and `fix-failed`
   * branches feeds runActor's convergence detector: two consecutive
   * iterations with the same classification key + `progress: false`
   * triggers the convergence-loop halt path.
   */
  async reflect(
    outcomes: ReadonlyArray<PrFixOutcome>,
    classified: Classified<PrFixObservation>,
    _ctx: ActorContext<PrFixAdapters>,
  ): Promise<Reflection> {
    const meta = (classified.metadata ?? {}) as { classification?: PrFixClassification };
    const cls = meta.classification ?? 'has-findings';
    if (cls === 'all-clean') {
      return { done: true, progress: false, note: 'all clean; nothing to fix' };
    }
    if (cls === 'partial') {
      return { done: false, progress: false, note: 'partial observation; retrying' };
    }
    const escalated = outcomes.find(o => o.kind === 'escalated');
    if (escalated !== undefined) {
      return { done: true, progress: false, note: escalated.reason };
    }
    const failed = outcomes.find(o => o.kind === 'fix-failed');
    if (failed !== undefined) {
      return { done: false, progress: false, note: failed.reason };
    }
    const fixPushed = outcomes.some(o => o.kind === 'fix-pushed');
    if (fixPushed) {
      return { done: false, progress: true, note: 'fix pushed; reobserving' };
    }
    return { done: false, progress: false, note: 'no progress' };
  }
}

// ---------------------------------------------------------------------------
// File-private classification helpers.
//
// Counters here are deliberately conservative: only completed+failure
// check-runs and explicit failure/error legacy statuses count as CI
// failures; anything pending (queued, in_progress, or `state: 'pending'`)
// is excluded so a transient in-flight check never trips the escalate
// branch. Architectural detection requires BOTH the literal severity
// marker AND a coarse-grained substring match, so a finding that just
// uses the word "major" in prose does not get escalated.
// ---------------------------------------------------------------------------

function countCiFailures(obs: PrFixObservation): number {
  const checkRunFails = obs.checkRuns.filter(
    (c) => c.status === 'completed' && c.conclusion === 'failure',
  ).length;
  const legacyFails = obs.legacyStatuses.filter(
    (s) => s.state === 'failure' || s.state === 'error',
  ).length;
  return checkRunFails + legacyFails;
}

// Orange-circle emoji marker (\u{1F7E0}) followed by ' Major' (case-insensitive).
// The reviewer's literal severity marker for major-severity findings.
// Combined with ARCH_SUBSTR_RE so a stray "major" in prose does not
// promote a comment to architectural.
const ARCH_MARKER_RE = /\u{1F7E0}\s*Major/iu;
const ARCH_SUBSTR_RE = /(architectural|large refactor|redesign)/i;

function countArchitectural(obs: PrFixObservation): number {
  let n = 0;
  for (const c of [...obs.lineComments, ...obs.bodyNits]) {
    if (ARCH_MARKER_RE.test(c.body) && ARCH_SUBSTR_RE.test(c.body)) n++;
  }
  return n;
}

// Compact summary of submitted-review states for the convergence key.
// Sorted alphabetically + joined with `+` so two iterations with the
// same set of reviewer states produce the same key regardless of
// fetch order. Returns '' for an empty review set.
function summarizeReviewState(reviews: ReadonlyArray<{ readonly state: string }>): string {
  if (reviews.length === 0) return '';
  return [...reviews].map((r) => r.state).sort().join('+');
}

// ---------------------------------------------------------------------------
// File-private propose helpers.
//
// `mintPlanAtomId` mints an id only; the plan atom itself is NOT written
// here. Whether/when a plan atom is persisted to the store is decided
// by `apply`. The id flows into the `agent-loop-dispatch` payload so
// downstream consumers (apply, the agent-loop substrate) can chain
// provenance back to a single plan-id per dispatch attempt.
//
// `describeCiFailures` and `describeArchitectural` build short prose
// summaries used inside the escalation `reason` field. Conservative:
// they return a literal `'unknown'` when no matching detail surfaces
// rather than throwing, so an unexpected shape does not abort the
// escalation path.
// ---------------------------------------------------------------------------

function mintPlanAtomId(): AtomId {
  const nonce = randomBytes(6).toString('hex');
  return `pr-fix-plan-${nonce}` as AtomId;
}

function describeCiFailures(obs: PrFixObservation): string {
  const failedRuns = obs.checkRuns
    .filter((c) => c.status === 'completed' && c.conclusion === 'failure')
    .map((c) => c.name);
  const failedStatuses = obs.legacyStatuses
    .filter((s) => s.state === 'failure' || s.state === 'error')
    .map((s) => s.context);
  const all = [...failedRuns, ...failedStatuses];
  return all.length === 0 ? 'unknown' : all.join(', ');
}

function describeArchitectural(obs: PrFixObservation): string {
  for (const c of [...obs.lineComments, ...obs.bodyNits]) {
    if (ARCH_MARKER_RE.test(c.body) && ARCH_SUBSTR_RE.test(c.body)) {
      const firstLine = c.body.split('\n', 1)[0]?.slice(0, 200) ?? '';
      return `${c.id}: ${firstLine}`;
    }
  }
  return 'unknown';
}
