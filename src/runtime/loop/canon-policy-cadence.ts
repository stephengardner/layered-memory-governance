/**
 * Shared canon-policy reader for numeric cadence / threshold dials.
 *
 * Multiple sibling readers in this folder all walked `directive` atoms
 * looking for `metadata.policy.subject === <subject>`, filtering taint
 * + superseded, accepting a canonical field plus the legacy `value`
 * back-compat alias, and falling through to a default when nothing
 * matched. The shared shape is captured here so each call site
 * reduces to a one-liner that names its policy + default.
 *
 * Substrate purity: the helper is mechanism-only. It takes structured
 * `{subject, fieldName, fallback, acceptInfinitySentinel?}` data in
 * and returns a number out; it never imports a vendor adapter, never
 * spawns a process, never branches on a deployment-specific shape.
 *
 * Sentinel handling: deployments using a policy whose value can be
 * legitimately disabled (e.g. webhook-driven freshness, infinite
 * orphan threshold) opt into the `'Infinity'` string sentinel via
 * `acceptInfinitySentinel: true`. JSON cannot encode the literal so
 * the canonical wire shape is the string; the helper folds it onto
 * `Number.POSITIVE_INFINITY` for callers. Other policies that have no
 * disable semantic leave the flag false (default) and a non-numeric
 * value falls through to the default.
 */

import type { Host } from '../../interface.js';

/**
 * Inputs for `readNumericCanonPolicy`. All fields are required except
 * `acceptInfinitySentinel` which defaults to false (no sentinel).
 */
export interface NumericCanonPolicyOptions {
  /** Policy `metadata.policy.subject` discriminator value. */
  readonly subject: string;
  /**
   * Canonical numeric-field name (e.g. 'interval_ms', 'freshness_ms',
   * 'threshold_ms'). The helper also accepts the legacy `'value'`
   * field for back-compat; deployments with an older bootstrap shape
   * stay readable without forcing a canon-rewrite migration.
   */
  readonly fieldName: string;
  /** Default returned when no clean, non-superseded, well-formed atom matches. */
  readonly fallback: number;
  /**
   * When true, the string literal `'Infinity'` on the policy field
   * folds to `Number.POSITIVE_INFINITY` (used by deployments that
   * disable a tick by setting its threshold infinite). Default false:
   * non-numeric values fall through to the default.
   */
  readonly acceptInfinitySentinel?: boolean;
}

/**
 * Read a canon-policy numeric value with the standard pattern.
 *
 * Walks `directive` atoms, filters taint='clean' + non-superseded,
 * matches `metadata.policy.subject === options.subject`, reads the
 * canonical field (with legacy `value` fallback), and returns the
 * configured number (or `Number.POSITIVE_INFINITY` for the opt-in
 * sentinel). Falls through to `options.fallback` on any malformed
 * payload, missing field, or absent atom.
 *
 * Pure mechanism: the helper never throws on malformed canon. The
 * goal is to keep the loop alive on a fat-fingered policy edit; the
 * operator sees the symptom (default behavior) and the policy atom
 * itself remains the audit trail.
 */
export async function readNumericCanonPolicy(
  host: Host,
  options: NumericCanonPolicyOptions,
): Promise<number> {
  const PAGE_SIZE = 200;
  // Constrain policy scan to L3 (canonical layer) so a same-subject
  // non-canon directive (L0/L1/L2) cannot impersonate authoritative
  // canon. Bound the scan via MAX_SCAN so per-tick read cost stays
  // O(1) as directive volume grows; an unbounded walk on a long-tail
  // store is the foot-gun this guard prevents.
  const MAX_SCAN = 5_000;
  let seen = 0;
  let cursor: string | undefined;
  do {
    const remaining = MAX_SCAN - seen;
    if (remaining <= 0) break;
    const page = await host.atoms.query(
      { type: ['directive'], layer: ['L3'] },
      Math.min(PAGE_SIZE, remaining),
      cursor,
    );
    seen += page.atoms.length;
    for (const atom of page.atoms) {
      if (atom.taint !== 'clean') continue;
      if (atom.superseded_by.length > 0) continue;
      const meta = atom.metadata as Record<string, unknown>;
      const policy = meta['policy'] as Record<string, unknown> | undefined;
      if (!policy || policy['subject'] !== options.subject) continue;
      // Named field follows the convention of the sibling cadence
      // policies (pol-actor-message-rate, pol-inbox-poll-cadence,
      // pol-pr-observation-freshness-threshold-ms). Back-compat read on
      // `value` keeps an older bootstrap shape readable while the
      // named-field shape is canonical going forward.
      const raw = policy[options.fieldName] ?? policy['value'];
      // Explicit disable sentinel for deployments that observe via a
      // webhook (or never want the tick to fire). JSON cannot encode
      // the literal Infinity, so the canonical wire shape is the
      // string 'Infinity'; folded onto POSITIVE_INFINITY here for
      // callers that opted in.
      if (options.acceptInfinitySentinel === true && raw === 'Infinity') {
        return Number.POSITIVE_INFINITY;
      }
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) continue;
      return raw;
    }
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);
  return options.fallback;
}

/**
 * Inputs for `readBooleanCanonPolicy`. All three fields are required.
 * No sentinel handling because a boolean has no "disabled / never
 * fire" analogue of the numeric reader's `'Infinity'` opt-in.
 */
export interface BooleanCanonPolicyOptions {
  /** Policy `metadata.policy.subject` discriminator value. */
  readonly subject: string;
  /**
   * Canonical boolean-field name (e.g. 'enabled'). The helper also
   * accepts the legacy `'value'` field for back-compat so a bootstrap
   * snapshot in the older shape stays readable while the named-field
   * shape is canonical going forward.
   */
  readonly fieldName: string;
  /** Default returned when no clean, non-superseded, well-formed atom matches. */
  readonly fallback: boolean;
}

/**
 * Read a canon-policy boolean value with the same shape as
 * `readNumericCanonPolicy`.
 *
 * Walks L3 `directive` atoms, filters taint='clean' + non-superseded,
 * matches `metadata.policy.subject === options.subject`, reads the
 * canonical field (with legacy `'value'` fallback), and returns the
 * configured boolean. Falls through to `options.fallback` on any
 * malformed payload (string, number, missing field) or absent atom.
 *
 * Strict typing on the read: a non-boolean is NOT coerced via
 * `Boolean(...)`. The string `"false"` is truthy, so coercion would
 * silently flip an explicit operator-typed `"false"` to `true` and
 * lie about the configured posture; the fall-through-to-default is
 * the loud-but-recoverable shape. The operator sees the symptom
 * (default behavior) and the policy atom itself remains the audit
 * trail.
 */
export async function readBooleanCanonPolicy(
  host: Host,
  options: BooleanCanonPolicyOptions,
): Promise<boolean> {
  const PAGE_SIZE = 200;
  // Constrain policy scan to L3 (canonical layer) so a same-subject
  // non-canon directive (L0/L1/L2) cannot impersonate authoritative
  // canon. Bound the scan via MAX_SCAN so per-tick read cost stays
  // O(1) as directive volume grows; mirrors readNumericCanonPolicy.
  const MAX_SCAN = 5_000;
  let seen = 0;
  let cursor: string | undefined;
  do {
    const remaining = MAX_SCAN - seen;
    if (remaining <= 0) break;
    const page = await host.atoms.query(
      { type: ['directive'], layer: ['L3'] },
      Math.min(PAGE_SIZE, remaining),
      cursor,
    );
    seen += page.atoms.length;
    for (const atom of page.atoms) {
      if (atom.taint !== 'clean') continue;
      if (atom.superseded_by.length > 0) continue;
      const meta = atom.metadata as Record<string, unknown>;
      const policy = meta['policy'] as Record<string, unknown> | undefined;
      if (!policy || policy['subject'] !== options.subject) continue;
      // Named field is canonical; `'value'` is the back-compat alias.
      const raw = policy[options.fieldName] ?? policy['value'];
      // Strict-typed read: only `true` / `false` round-trip; any other
      // shape (string, number, null, missing) falls through to the
      // default. See doc-comment above for why coercion is wrong.
      if (typeof raw !== 'boolean') continue;
      return raw;
    }
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);
  return options.fallback;
}
