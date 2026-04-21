/**
 * BridgeAtomStore.
 *
 * Wraps a backing AtomStore (typically file- or memory-based) and adds a
 * one-shot `bootstrapFromChroma()` operation that pulls drawers from
 * the external ChromaDB store palace and imports them as LAG atoms.
 *
 * Design choice: bridge does not manage primary storage itself. The backing
 * adapter owns that, which keeps bridge responsibilities narrow and
 * lets us reuse the cross-session properties of the file adapter.
 *
 * Mapping from bridge drawer to LAG atom:
 *   drawer.id          -> atom.id
 *   drawer.document    -> atom.content
 *   drawer.metadata.agent / .wing / .room / .session_id  -> provenance hints
 *   drawer.metadata.timestamp / created_at               -> created_at
 *   atom.layer         = 'L1' (drawers are raw observations)
 *   atom.provenance.kind = 'agent-observed'
 *   atom.taint         = 'clean'
 *   atom.confidence    = 0.5 (default; can be refined by arbitration later)
 */

import type { AtomStore } from '../../substrate/interface.js';
import { ConflictError } from '../../substrate/errors.js';
import type {
  Atom,
  AtomFilter,
  AtomId,
  AtomPage,
  AtomPatch,
  PrincipalId,
  SearchHit,
  Time,
  Vector,
} from '../../substrate/types.js';
import {
  dumpDrawers,
  type BootstrapOptions,
  type BridgeDrawer,
} from './drawer-bridge.js';

export interface BridgeAtomStoreOptions {
  /** Principal id stamped on bootstrapped atoms by default. */
  readonly defaultPrincipalId: PrincipalId;
  /** Namespace prefix for imported atom ids, avoids clashes with native atoms. */
  readonly importedIdPrefix?: string;
}

export interface BootstrapResult {
  readonly fetched: number;
  readonly imported: number;
  readonly skipped: number;
  readonly errors: ReadonlyArray<{ id: string; reason: string }>;
}

export class BridgeAtomStore implements AtomStore {
  private readonly prefix: string;

  constructor(
    private readonly backing: AtomStore,
    private readonly options: BridgeAtomStoreOptions,
  ) {
    this.prefix = options.importedIdPrefix ?? 'phx_';
  }

  // ---- AtomStore delegation ----

  async put(atom: Atom): Promise<AtomId> {
    return this.backing.put(atom);
  }

  async get(id: AtomId): Promise<Atom | null> {
    return this.backing.get(id);
  }

  async query(
    filter: AtomFilter,
    limit: number,
    cursor?: string,
  ): Promise<AtomPage> {
    return this.backing.query(filter, limit, cursor);
  }

  async search(
    query: string | Vector,
    k: number,
    filter?: AtomFilter,
  ): Promise<ReadonlyArray<SearchHit>> {
    return this.backing.search(query, k, filter);
  }

  async update(id: AtomId, patch: AtomPatch): Promise<Atom> {
    return this.backing.update(id, patch);
  }

  async batchUpdate(filter: AtomFilter, patch: AtomPatch): Promise<number> {
    return this.backing.batchUpdate(filter, patch);
  }

  async embed(text: string): Promise<Vector> {
    return this.backing.embed(text);
  }

  similarity(a: Vector, b: Vector): number {
    return this.backing.similarity(a, b);
  }

  contentHash(text: string): string {
    return this.backing.contentHash(text);
  }

  // ---- Bootstrap ----

  /**
   * Pull drawers from an external ChromaDB-backed store and import them as L1 atoms.
   * Idempotent: already-present atoms (same id) are skipped, not errored.
   */
  async bootstrapFromChroma(
    palacePath: string,
    options: BootstrapOptions = {},
  ): Promise<BootstrapResult> {
    const drawers = await dumpDrawers(palacePath, options);
    let imported = 0;
    let skipped = 0;
    const errors: Array<{ id: string; reason: string }> = [];
    for (const drawer of drawers) {
      const atom = mapDrawerToAtom(drawer, {
        defaultPrincipalId: this.options.defaultPrincipalId,
        prefix: this.prefix,
      });
      try {
        await this.backing.put(atom);
        imported += 1;
      } catch (err) {
        if (err instanceof ConflictError) {
          skipped += 1;
        } else {
          errors.push({
            id: drawer.id,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    return {
      fetched: drawers.length,
      imported,
      skipped,
      errors,
    };
  }

}

// ---------------------------------------------------------------------------
// Pure mapping helper (exported for unit testing).
// ---------------------------------------------------------------------------

export interface MapDrawerOptions {
  readonly defaultPrincipalId: PrincipalId;
  readonly prefix?: string;
  /** Override `imported_at` timestamp (defaults to now). Primarily for tests. */
  readonly now?: string;
}

export function mapDrawerToAtom(
  drawer: BridgeDrawer,
  options: MapDrawerOptions,
): Atom {
  const meta = drawer.metadata ?? {};
  const agentRaw = meta['agent'] ?? meta['agent_id'] ?? meta['principal_id'];
  const principalId = typeof agentRaw === 'string' && agentRaw.length > 0
    ? (agentRaw as PrincipalId)
    : options.defaultPrincipalId;
  const createdAtRaw = meta['created_at'] ?? meta['timestamp'] ?? meta['filed_at'];
  const createdAt = typeof createdAtRaw === 'string' && createdAtRaw.length > 0
    ? createdAtRaw
    : new Date(0).toISOString();
  const prefix = options.prefix ?? 'phx_';
  const atomId = (prefix + drawer.id) as AtomId;
  return {
    schema_version: 1,
    id: atomId,
    content: drawer.document,
    type: 'observation',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: {
        tool: 'bridge-chroma',
        ...(typeof meta['session_id'] === 'string' ? { session_id: meta['session_id'] } : {}),
        ...(typeof agentRaw === 'string' ? { agent_id: agentRaw } : {}),
      },
      derived_from: [],
    },
    confidence: 0.5,
    created_at: createdAt as Time,
    last_reinforced_at: createdAt as Time,
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
    principal_id: principalId,
    taint: 'clean',
    metadata: {
      bridge_drawer_id: drawer.id,
      bridge_wing: meta['wing'],
      bridge_room: meta['room'],
      imported_at: options.now ?? new Date().toISOString(),
    },
  };
}
