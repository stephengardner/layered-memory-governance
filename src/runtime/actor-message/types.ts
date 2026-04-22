/**
 * Actor-message primitive: inter-actor messaging atoms.
 *
 * An `actor-message` is how one principal signals another through the
 * AtomStore. A sender writes one; the recipient picks it up via its
 * scheduler tick and acknowledges by writing an `actor-message-ack`
 * atom whose `derived_from` points at the original message.
 *
 * Transport is the AtomStore. There is no new Host sub-interface for
 * messaging; AtomStore.put + AtomStore.list are sufficient. Any
 * AtomStore adapter (memory, file, postgres) carries the inbox for
 * free without widening the Host boundary.
 *
 * Write discipline: every `actor-message` is validated at write time
 * against:
 *   - a token-bucket rate limiter (pol-actor-message-rate policy
 *     atoms; per-principal overrides supported);
 *   - a trip-count circuit breaker (pol-actor-message-circuit-breaker);
 *     3 denials inside window_ms trips the breaker and rejects further
 *     writes from the offending principal until an operator-signed
 *     reset atom clears the trip.
 *
 * V1 core fields are additive-only. Future fields (thread_id,
 * capabilities_requested, reply_to, tracing) ride in `metadata`
 * with a graduation rule: keys reaching >=3 consumers are promoted
 * to core. This protects both old atoms from schema migrations and
 * new consumers from rigidity.
 */

import type { AtomId, PrincipalId, Time } from '../../types.js';

/**
 * Urgency tier. A policy-atom-driven ordering function uses this plus
 * arrival time and deadline to pick the next message for pickup.
 * Intentionally small: the framework ships three levels; deployments
 * that need finer tiers shape them via metadata + a custom ordering
 * policy atom.
 */
export type UrgencyTier = 'soft' | 'normal' | 'high';

/**
 * V1 core fields of an actor-message. Stored on the atom under
 * `metadata.actor_message`, not at the top level, so the regular
 * Atom shape (with its provenance, principal_id, etc.) is unchanged.
 *
 * The `from` field here is what the message claims about itself; the
 * trust-bearing author is the atom's top-level `principal_id` (written
 * by the AtomStore from signed context, never by the caller). When
 * consumers want "who actually sent this," they read `atom.principal_id`,
 * not `metadata.actor_message.from`. `from` is here for ergonomics and
 * audit-trail readability; any authority decision uses `principal_id`.
 */
export interface ActorMessageV1 {
  /** Recipient principal. The inbox reader queries by this. */
  readonly to: PrincipalId;
  /**
   * Sender principal as claimed in the body. Use atom.principal_id for
   * authority decisions; this field is for audit readability.
   */
  readonly from: PrincipalId;
  /** Short topic tag. Free-form; deployments standardize via policy. */
  readonly topic: string;
  readonly urgency_tier: UrgencyTier;
  /** Optional ISO deadline for deadline-sensitive pickup ordering. */
  readonly deadline_ts?: Time;
  /**
   * Optional correlation id for request/response threading. Sub-actor
   * replies carry the originating message's correlation_id so the
   * inbox reader can re-pair them.
   */
  readonly correlation_id?: string;
  /** The message body. Markdown-friendly plain text. */
  readonly body: string;
}

/**
 * Envelope of a circuit-breaker trip record. Written by the write-time
 * rate limiter when a principal exceeds the denial threshold inside
 * window_ms. The breaker reads this to know whether a principal is
 * currently tripped; a matching `circuit-breaker-reset` atom
 * supersedes it.
 */
export interface CircuitBreakerTripV1 {
  /** The principal whose writes are now rejected. */
  readonly target_principal: PrincipalId;
  /** Reason for the trip (e.g. "3 denials in 300000ms"). */
  readonly reason: string;
  /** How many denials were observed inside the window. */
  readonly denial_count: number;
  /** The window (ms) the denial count was measured over. */
  readonly window_ms: number;
  /** ISO timestamp of the trip. Redundant with atom.created_at but
   *  kept for query-time convenience. */
  readonly tripped_at: Time;
}

/**
 * Envelope of a circuit-breaker reset. Clears a specific trip by id;
 * must be signed by an authorized principal per the
 * pol-circuit-breaker-reset-authority policy atom. The validator
 * enforces (a) trip_atom_id resolves to an existing trip, (b) that
 * trip is not already referenced by an earlier reset (one-shot),
 * (c) signer authority, (d) target match, (e) non-empty reason.
 */
export interface CircuitBreakerResetV1 {
  readonly target_principal: PrincipalId;
  /** The `circuit-breaker-trip` atom id being reset. */
  readonly trip_atom_id: AtomId;
  readonly reset_reason: string;
  /** Signer principal; must satisfy pol-circuit-breaker-reset-authority. */
  readonly authorizing_principal: PrincipalId;
}

/**
 * Envelope of an actor-message acknowledgment. Emitted by the inbox
 * reader when it has picked up and processed a message. Idempotent:
 * re-emitting an ack for an already-acked message is a no-op; the
 * reader uses the presence of an ack (with matching `message_atom_id`
 * in derived_from) to mark a message "read".
 */
export interface ActorMessageAckV1 {
  readonly message_atom_id: AtomId;
  readonly acked_by: PrincipalId;
  readonly acked_at: Time;
}
