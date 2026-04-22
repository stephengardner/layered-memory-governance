/**
 * Operator-escalation actor-message helper.
 *
 * When an Actor halts with anything other than `converged`, OR leaves
 * the loop with items it could not act on (escalations, body-scoped
 * nits the reviewer posted inside a review body rather than as
 * replyable line comments), the operator needs to know; otherwise
 * the escalation dies in the CI log and the PR sits waiting forever.
 *
 * This helper writes a single `actor-message` atom from the halting
 * actor to the operator principal. The file-backed Notifier / Telegram
 * daemon / any other inbox consumer picks it up via the existing
 * pickup infrastructure and delivers it.
 *
 * Design notes:
 *
 * - This is NOT framework-level. runActor remains unchanged; actors
 *   remain unchanged. The caller (an Actor runner script) decides
 *   whether to emit and provides the context. Second instance of this
 *   pattern would justify extracting a runActor hook; one concrete
 *   caller is enough for inline-today.
 *
 * - The message body is rendered by `renderEscalationBody` and follows
 *   a line-per-intent contract: every PR link, halt reason, and
 *   escalation item is one logical line so channels with tight line
 *   limits (chat apps, email previews, terminal-width dashboards) can
 *   all show a useful prefix without truncation mid-claim. Proposed-fix
 *   diffs are inlined as fenced ```diff blocks so the operator can
 *   copy them straight into `git apply`.
 *
 * - Caller-determined atom id. A deterministic id lets callers make
 *   the emit idempotent (same halt on the same PR → same atom id, so
 *   re-runs de-dup). The default id folds in actor + PR + iteration
 *   count + halt reason.
 */

import type { Host } from '../../interface.js';
import type { ActorReport } from '../actors/types.js';
import type { ReviewComment } from '../actors/pr-review/adapter.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../types.js';
import { ConflictError } from '../../errors.js';
import type { ActorMessageV1, UrgencyTier } from './types.js';

export interface OperatorEscalationContext {
  readonly host: Host;
  readonly report: ActorReport;
  /**
   * The PR the actor was operating on. Used to render a clickable link
   * at the top of the escalation message and in the topic tag. Optional
   * so this helper can be reused by non-PR actors in the future.
   */
  readonly pr?: {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
    readonly title?: string;
  };
  /**
   * Final observation state captured after runActor halted. Used to
   * render the "unresolved items" section. If the caller cannot
   * provide this, the message still sends with halt reason +
   * escalations but omits the items list.
   */
  readonly observation?: {
    readonly comments: ReadonlyArray<ReviewComment>;
    readonly bodyNits: ReadonlyArray<ReviewComment>;
  };
  /**
   * The recipient principal. Defaults to 'operator'. Override for
   * deployments that use a different convention (e.g., 'stephen-human').
   */
  readonly operator?: PrincipalId;
  /**
   * Origin tag carried in metadata.origin for audit readability (e.g.,
   * 'github-action', 'local-cli'). Plays no role in delivery.
   */
  readonly origin?: string;
  /**
   * Overrides for testing. In production these default to the real
   * wall clock and Date.now-based ids.
   */
  readonly now?: () => number;
}

/**
 * Decide whether a given ActorReport should trigger an escalation
 * message. Callers are free to invoke the helper unconditionally and
 * let this function decide, OR to implement their own policy.
 *
 * Today the rule is: emit if halt reason is anything other than
 * `converged`, OR if the report carries any escalations, OR if the
 * observation contains body-nits (which the actor by design cannot
 * resolve and therefore count as unhandled).
 */
export function shouldEscalate(
  report: ActorReport,
  observation?: { readonly bodyNits: ReadonlyArray<ReviewComment> },
): boolean {
  if (report.haltReason !== 'converged') return true;
  if (report.escalations.length > 0) return true;
  if (observation && observation.bodyNits.length > 0) return true;
  return false;
}

/**
 * Outcome of an escalation atom write. The caller needs to know
 * whether this was a new write or a deduped retry so secondary
 * delivery channels (PR comments, Slack posts, etc.) can stay
 * idempotent too. A repeat call for the same halt on the same PR
 * returns `alreadyExisted: true` and should NOT trigger another
 * secondary post.
 */
export interface EscalationWriteOutcome {
  readonly atomId: AtomId;
  readonly alreadyExisted: boolean;
}

/**
 * Deterministic id for a given escalation context. Exported so
 * callers can pre-check whether this specific halt has already been
 * surfaced without having to re-render the full context.
 */
export function escalationAtomId(ctx: OperatorEscalationContext): AtomId {
  return mkEscalationId(ctx);
}

/**
 * Write the escalation actor-message atom. Idempotent per call-site:
 * a repeat call with the same context returns the same atom id and
 * signals via `alreadyExisted: true` that no new write happened.
 */
export async function sendOperatorEscalation(
  ctx: OperatorEscalationContext,
): Promise<EscalationWriteOutcome> {
  const now = ctx.now ?? (() => Date.now());
  const nowIso = new Date(now()).toISOString() as Time;
  const operator: PrincipalId = ctx.operator ?? ('operator' as PrincipalId);
  const urgency: UrgencyTier = pickUrgency(ctx.report);

  const atomId = mkEscalationId(ctx);
  const body = renderEscalationBody(ctx);
  const topic = ctx.pr
    ? `actor-halt:${ctx.report.actor}:${ctx.pr.owner}/${ctx.pr.repo}#${ctx.pr.number}`
    : `actor-halt:${ctx.report.actor}`;

  const envelope: ActorMessageV1 = {
    to: operator,
    from: ctx.report.principal,
    topic,
    urgency_tier: urgency,
    body,
    correlation_id: atomId,
  };

  const atom: Atom = {
    schema_version: 1,
    id: atomId,
    content: body,
    type: 'actor-message',
    layer: 'L0',
    provenance: {
      kind: 'agent-observed',
      source: {
        agent_id: String(ctx.report.principal),
        tool: 'operator-escalation',
        ...(ctx.origin !== undefined ? { session_id: ctx.origin } : {}),
      },
      derived_from: [],
    },
    confidence: 1.0,
    created_at: nowIso,
    last_reinforced_at: nowIso,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: ctx.report.principal,
    taint: 'clean',
    metadata: {
      actor_message: envelope,
      escalation: {
        halt_reason: ctx.report.haltReason,
        iterations: ctx.report.iterations,
        escalations: ctx.report.escalations,
        ...(ctx.pr ? { pr: ctx.pr } : {}),
        ...(ctx.observation
          ? {
            unresolved_line_comments: ctx.observation.comments.length,
            body_nits: ctx.observation.bodyNits.length,
          }
          : {}),
      },
    },
  };

  // Idempotency: deterministic ids mean repeat invocations for the
  // same halt on the same PR should be no-ops. The AtomStore contract
  // rejects duplicate ids with ConflictError; we treat that as a
  // successful "already-present" state so callers can safely retry
  // without needing their own dedup. The return signals which branch
  // took so secondary delivery channels can stay idempotent too
  // (e.g., don't re-post a PR comment for a halt already surfaced).
  let alreadyExisted = false;
  try {
    await ctx.host.atoms.put(atom);
  } catch (err) {
    if (!(err instanceof ConflictError)) throw err;
    alreadyExisted = true;
  }
  return { atomId, alreadyExisted };
}

function pickUrgency(report: ActorReport): UrgencyTier {
  if (report.haltReason === 'error') return 'high';
  if (report.haltReason === 'kill-switch') return 'high';
  if (report.haltReason === 'policy-escalate-blocking') return 'normal';
  return 'normal';
}

function mkEscalationId(ctx: OperatorEscalationContext): AtomId {
  // Deterministic-ish id: actor + PR + halt reason + iteration count.
  // This keeps re-emits of the SAME halt over the SAME PR idempotent
  // across script re-runs while letting a later halt on the same PR
  // (e.g., different halt reason) produce a distinct atom.
  const prKey = ctx.pr
    ? `${ctx.pr.owner}-${ctx.pr.repo}-${ctx.pr.number}`
    : 'no-pr';
  return `escalation-${ctx.report.actor}-${prKey}-${ctx.report.haltReason}-it${ctx.report.iterations}` as AtomId;
}

/**
 * Render the operator-escalation message as a markdown string.
 *
 * Exported so callers in contexts with an ephemeral atom store
 * (most commonly GitHub Actions runners, where `.lag/` is torn
 * down at job end) can ALSO post this same body as a PR comment
 * or pipe it into another delivery channel (Slack, email, etc.).
 * Without that second channel, a halt-escalation would reach the
 * AtomStore and die there along with the runner.
 *
 * The body renders identically whether it is used for the atom's
 * `content` field or for a PR comment: markdown-flavored, PR link
 * in body, fenced `diff` blocks for proposed fixes, sectioned
 * headings for unresolved items.
 */
export function renderEscalationBody(ctx: OperatorEscalationContext): string {
  const { report, pr, observation } = ctx;
  const lines: string[] = [];

  const titleStub = pr
    ? `${report.actor} halt on ${pr.owner}/${pr.repo}#${pr.number}`
    : `${report.actor} halt`;
  lines.push(`**${titleStub}**`);
  lines.push('');

  lines.push(
    `Halt: \`${report.haltReason}\`  ·  iterations=${report.iterations}  ·  `
    + `${report.startedAt} → ${report.endedAt}`,
  );
  if (report.lastNote) {
    lines.push(`Last note: ${report.lastNote}`);
  }
  if (pr) {
    lines.push('');
    lines.push(`https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`);
    if (pr.title) lines.push(`_${pr.title}_`);
  }

  if (report.escalations.length > 0) {
    lines.push('');
    lines.push(`## Escalations (${report.escalations.length})`);
    for (const e of report.escalations) {
      lines.push(`- ${e}`);
    }
  }

  if (observation) {
    const openLine = observation.comments.filter((c) => !c.resolved);
    if (openLine.length > 0) {
      lines.push('');
      lines.push(`## Unresolved line comments (${openLine.length})`);
      for (const c of openLine) {
        lines.push(renderCommentLine(c));
        if (c.proposedFix) lines.push(renderProposedFixBlock(c.proposedFix));
      }
    }

    if (observation.bodyNits.length > 0) {
      lines.push('');
      lines.push(
        `## Body-scoped nits (${observation.bodyNits.length})`,
      );
      lines.push(
        '_Posted inside a reviewer\'s review body; not replyable as a thread. Apply or dismiss directly on the PR._',
      );
      for (const n of observation.bodyNits) {
        lines.push(renderCommentLine(n));
        if (n.proposedFix) lines.push(renderProposedFixBlock(n.proposedFix));
      }
    }
  }

  return lines.join('\n');
}

function renderCommentLine(c: ReviewComment): string {
  const loc = c.path && c.line !== undefined
    ? `\`${c.path}\`:${c.line}`
    : c.path
      ? `\`${c.path}\``
      : `comment \`${c.id}\``;
  const author = c.author;
  const title = firstLineOf(c.body);
  return `- ${loc} - ${author}: ${title}`;
}

function firstLineOf(body: string): string {
  // Use the first non-empty line as the headline. Markdown titles
  // start with `**` and we strip the bold markers for a cleaner
  // one-liner. Truncate to 120 chars so the escalation message stays
  // readable in Telegram / terminal.
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const stripped = line.replace(/^\*\*/, '').replace(/\*\*$/, '');
    return stripped.length > 120 ? stripped.slice(0, 117) + '...' : stripped;
  }
  return '(empty comment body)';
}

function renderProposedFixBlock(diff: string): string {
  // Trim outer blank lines but preserve the diff content exactly so
  // the operator can copy it into `git apply` without reformatting.
  //
  // Two-space indent on the fences is deliberate: the fenced block is
  // nested inside an existing list item (the caller renders it right
  // after a `- <path>:<line> - <author>: <title>` line), and Markdown
  // renderers need >= 2-space indentation to treat the fenced block
  // as a continuation of the list item rather than a top-level code
  // block breaking out of the list. GitHub's renderer, Telegram's
  // markdown flavor, and most chat/mail clients agree on this. Do
  // not strip the indent.
  const trimmed = diff.replace(/^\n+/, '').replace(/\n+$/, '');
  return ['  ```diff', trimmed, '  ```'].join('\n');
}
