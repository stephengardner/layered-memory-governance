/**
 * Agent SDK checkpoints.
 *
 * A checkpoint preserves an agent's in-flight messages array so a paused
 * run can resume without losing context. Checkpoints are persisted as
 * regular atoms (type='observation', metadata.kind='agent-checkpoint')
 * so they participate in the substrate's provenance, taint, and audit
 * invariants like any other write.
 *
 * Shape choices:
 *   - Layer L0: checkpoints are transient session state; they do NOT
 *     claim canonical authority. Promotion mechanics never surface them.
 *   - principal_id = supplied agent id: the author of the reasoning that
 *     produced the messages array owns the checkpoint.
 *   - provenance.kind = 'agent-observed': the agent observed its own
 *     state at the checkpoint moment.
 *   - derived_from = empty: a checkpoint is a snapshot, not a derivation
 *     of prior atoms. Consumers wanting to tie a checkpoint back to a
 *     specific atom set must do so via metadata or a surrounding
 *     wrapper; keeping derived_from empty avoids synthetic taint edges.
 *
 * This module keeps the AtomStore dependency narrow (put + get only)
 * so callers that supply a restricted adapter still get checkpoint
 * semantics.
 */

import { randomUUID } from 'node:crypto';

import type { AtomStore } from '../../substrate/interface.js';
import type {
  Atom,
  AtomId,
  PrincipalId,
} from '../../substrate/types.js';

const CHECKPOINT_KIND = 'agent-checkpoint';

/**
 * Persist the messages array as an observation atom and return its id.
 *
 * The id is derived from the agent id + current wall clock + a random
 * UUID so repeated or concurrent calls produce distinct atoms even when
 * they land in the same millisecond. Date.now() alone was insufficient
 * because ms-granular collisions happened on rapid or parallel saves
 * and AtomStore.put() threw ConflictError, silently losing the
 * checkpoint. Callers that require a deterministic id (e.g.
 * content-hash idempotency) should wrap this function with their own
 * id policy.
 */
export async function saveCheckpoint(
  atomStore: AtomStore,
  agentId: PrincipalId,
  messages: unknown[],
): Promise<AtomId> {
  const now = new Date().toISOString();
  const id = buildCheckpointId(agentId, Date.now(), randomUUID());
  const atom: Atom = {
    schema_version: 1,
    id: id as AtomId,
    content: JSON.stringify(messages),
    type: 'observation',
    layer: 'L0',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: String(agentId) },
      derived_from: [],
    },
    confidence: 1,
    created_at: now,
    last_reinforced_at: now,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'session',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: agentId,
    taint: 'clean',
    metadata: { kind: CHECKPOINT_KIND },
  };

  await atomStore.put(atom);
  return id as AtomId;
}

/**
 * Load a checkpoint by id and return the messages array stored at save
 * time. Throws with a descriptive message when the atom is absent or
 * does not actually represent an agent checkpoint; the coordinator
 * surfaces that to the operator rather than silently starting a fresh
 * session. Validating the shape (type='observation', layer='L0',
 * metadata.kind=CHECKPOINT_KIND) closes a seam where an unrelated
 * observation whose content happened to be a JSON array could be
 * loaded and fed back to an agent as its resume context.
 */
export async function loadCheckpoint(
  atomStore: AtomStore,
  checkpointId: AtomId,
): Promise<unknown[]> {
  const atom = await atomStore.get(checkpointId);
  if (atom === null) {
    throw new Error(`[agent-sdk] Checkpoint not found: ${String(checkpointId)}`);
  }
  if (
    atom.type !== 'observation'
    || atom.layer !== 'L0'
    || atom.metadata['kind'] !== CHECKPOINT_KIND
  ) {
    throw new Error(
      `[agent-sdk] Atom ${String(checkpointId)} is not an agent checkpoint`,
    );
  }
  const parsed: unknown = JSON.parse(atom.content);
  if (!Array.isArray(parsed)) {
    throw new Error(
      `[agent-sdk] Checkpoint ${String(checkpointId)} is not a JSON array`,
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildCheckpointId(
  agentId: PrincipalId,
  epochMs: number,
  nonce: string,
): string {
  return `checkpoint-${String(agentId)}-${epochMs}-${nonce}`;
}
