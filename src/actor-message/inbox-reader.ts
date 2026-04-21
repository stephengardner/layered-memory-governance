/**
 * Inbox reader: pure query over actor-message atoms.
 *
 * The reader has NO new Host sub-interface. It's a function over
 * `host.atoms.query()` + `.metadata.actor_message.to` matching +
 * ack-presence filtering. Any AtomStore adapter (memory, file,
 * postgres) carries the inbox for free.
 *
 * Acknowledgment is represented by an `actor-message-ack` atom whose
 * `derived_from` includes the original message atom id. A message is
 * "unread" iff no ack atom references it. Idempotent: re-emitting an
 * ack is a no-op because the reader keys on the message atom id, not
 * the ack's own id.
 */

import type { Host } from '../substrate/interface.js';
import type { Atom, AtomId, PrincipalId, Time } from '../substrate/types.js';
import type { ActorMessageAckV1, ActorMessageV1 } from './types.js';

/**
 * A message atom paired with its parsed envelope. Shape mirrors what
 * a pickup handler needs to decide ordering (urgency, deadline) and
 * what a consumer needs to process the message (from, topic, body).
 */
export interface InboxMessage {
  readonly atom: Atom;
  readonly envelope: ActorMessageV1;
}

export interface ListUnreadOptions {
  /**
   * Optional upper bound on atoms to scan. Defaults to 1000.
   * Reader is intended for tick-sized queries; if an inbox has >1000
   * unread messages the deployment has a bigger problem the operator
   * should surface via the depth-based escalation, not absorb here.
   */
  readonly maxScan?: number;
}

/**
 * Return actor-message atoms addressed to `principalId` that are not
 * yet acknowledged. Sort order is not stable here; the pickup handler
 * applies the ordering policy.
 */
export async function listUnread(
  host: Host,
  principalId: PrincipalId,
  options: ListUnreadOptions = {},
): Promise<ReadonlyArray<InboxMessage>> {
  const maxScan = options.maxScan ?? 1000;
  const [msgPage, ackPage] = await Promise.all([
    host.atoms.query({ type: ['actor-message'] }, maxScan),
    host.atoms.query({ type: ['actor-message-ack'] }, maxScan),
  ]);
  // Collect the set of message ids that have been acked.
  const ackedMessageIds = new Set<string>();
  for (const ack of ackPage.atoms) {
    const envelope = extractAckEnvelope(ack);
    if (envelope === null) continue;
    ackedMessageIds.add(String(envelope.message_atom_id));
    // Also honor derived_from ids for robustness against envelope
    // shape drift: any ack that derives from a message atom acks it.
    for (const id of ack.provenance.derived_from) {
      ackedMessageIds.add(String(id));
    }
  }

  const result: InboxMessage[] = [];
  for (const atom of msgPage.atoms) {
    if (atom.superseded_by.length > 0) continue;
    if (atom.taint !== 'clean') continue;
    if (ackedMessageIds.has(String(atom.id))) continue;
    const envelope = extractMessageEnvelope(atom);
    if (envelope === null) continue;
    if (String(envelope.to) !== String(principalId)) continue;
    result.push({ atom, envelope });
  }
  return result;
}

/**
 * Emit an actor-message-ack atom for a given message. Idempotent:
 * checks for an existing ack with matching message_atom_id first and
 * skips the write if present. Returns the ack atom id (either newly
 * written or existing).
 */
export async function emitAck(
  host: Host,
  message: InboxMessage,
  ackedBy: PrincipalId,
  options: { readonly now?: () => number } = {},
): Promise<AtomId> {
  const now = options.now ?? (() => Date.now());
  // Deterministic ack id keyed on the message atom id so concurrent
  // emitAck calls for the same message converge on the same id. An
  // actor-message has exactly one recipient, so exactly one ack is
  // meaningful, and a `ConflictError` on put is the idempotency
  // signal.
  const ackId = `ama-${String(message.atom.id)}` as unknown as AtomId;

  // Fast path: if the ack already exists, return it without trying
  // to write.
  const existingAckId = await findExistingAck(host, message.atom.id);
  if (existingAckId !== null) return existingAckId;

  const nowIso = new Date(now()).toISOString() as Time;
  const envelope: ActorMessageAckV1 = {
    message_atom_id: message.atom.id,
    acked_by: ackedBy,
    acked_at: nowIso,
  };

  const atom: Atom = {
    schema_version: 1,
    id: ackId,
    content: `ack of ${String(message.atom.id)} by ${String(ackedBy)}`,
    type: 'actor-message-ack',
    layer: 'L0',
    provenance: {
      kind: 'agent-observed',
      source: { tool: 'inbox-reader', agent_id: String(ackedBy) },
      derived_from: [message.atom.id],
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
    principal_id: ackedBy,
    taint: 'clean',
    metadata: { ack: envelope },
  };
  try {
    await host.atoms.put(atom);
  } catch (err) {
    // ConflictError signals another writer wrote the same id between
    // our findExistingAck and our put. That's the exact concurrent-
    // emitAck race we guard against; the competing writer won, and
    // the stored ack is definitionally correct (same deterministic
    // id, same envelope shape). Return the id; do not rethrow.
    const existingAck = await host.atoms.get(ackId);
    if (existingAck !== null) return ackId;
    // Not a conflict (or the store is misbehaving) - surface the error.
    throw err;
  }
  return ackId;
}

/**
 * Scan the ack set for one whose envelope points at the given message
 * id. Used by emitAck's idempotency check.
 */
async function findExistingAck(
  host: Host,
  messageId: AtomId,
): Promise<AtomId | null> {
  const page = await host.atoms.query({ type: ['actor-message-ack'] }, 1000);
  for (const ack of page.atoms) {
    const envelope = extractAckEnvelope(ack);
    if (envelope !== null && String(envelope.message_atom_id) === String(messageId)) {
      return ack.id;
    }
    if (ack.provenance.derived_from.some((id) => String(id) === String(messageId))) {
      return ack.id;
    }
  }
  return null;
}

function extractMessageEnvelope(atom: Atom): ActorMessageV1 | null {
  const raw = (atom.metadata as Record<string, unknown>)?.actor_message;
  if (raw === undefined || raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.to !== 'string') return null;
  if (typeof obj.from !== 'string') return null;
  if (typeof obj.topic !== 'string') return null;
  if (typeof obj.body !== 'string') return null;
  const urgency = obj.urgency_tier;
  if (urgency !== 'soft' && urgency !== 'normal' && urgency !== 'high') return null;
  return {
    to: obj.to as PrincipalId,
    from: obj.from as PrincipalId,
    topic: obj.topic,
    urgency_tier: urgency,
    body: obj.body,
    ...(typeof obj.deadline_ts === 'string' ? { deadline_ts: obj.deadline_ts as Time } : {}),
    ...(typeof obj.correlation_id === 'string' ? { correlation_id: obj.correlation_id } : {}),
  };
}

function extractAckEnvelope(atom: Atom): ActorMessageAckV1 | null {
  const raw = (atom.metadata as Record<string, unknown>)?.ack;
  if (raw === undefined || raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.message_atom_id !== 'string') return null;
  if (typeof obj.acked_by !== 'string') return null;
  if (typeof obj.acked_at !== 'string') return null;
  return {
    message_atom_id: obj.message_atom_id as AtomId,
    acked_by: obj.acked_by as PrincipalId,
    acked_at: obj.acked_at as Time,
  };
}
