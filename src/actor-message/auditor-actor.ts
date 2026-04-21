/**
 * AuditorActor: read-only introspection of the atom store, emits
 * finding atoms and a summary actor-message.
 *
 * Fits a delegation pattern: a plan routes here via
 * metadata.delegation; this actor reads whatever scope the payload
 * asks for, aggregates governance-relevant findings (tainted atoms,
 * unresolved trips, orphan provenance), and writes an observation
 * atom + a reply message.
 *
 * Explicit non-goals:
 * - No mutation. The auditor only reads; any remediation is a
 *   separate plan written by a caller with write authority.
 * - No LLM reasoning. The auditor ships with deterministic checks
 *   so its output is reproducible and its cost is zero. A future
 *   phase can add an LLM-backed auditor as a separate actor.
 */

import type { Host } from '../substrate/interface.js';
import type { Atom, AtomId, AtomType, PrincipalId, Time } from '../substrate/types.js';
import type { ActorMessageV1, UrgencyTier } from './types.js';
import type { InvokeResult } from './sub-actor-registry.js';

export interface AuditorPayload {
  /** Destination principal for the audit result message. */
  readonly reply_to: PrincipalId;
  /**
   * Optional filter. When present, only atoms matching these fields
   * are audited. Missing = audit the whole project scope.
   */
  readonly filter?: {
    readonly principal_id?: PrincipalId;
    readonly type?: ReadonlyArray<AtomType>;
  };
}

export interface AuditFinding {
  readonly severity: 'info' | 'warn' | 'critical';
  readonly kind: string;
  readonly detail: string;
  /**
   * Child / in-scope atom ids the finding refers to. Consumers can
   * re-query these via host.atoms.get to materialize the full atoms.
   * For the 'orphan-provenance' finding these are the CHILDREN with
   * a broken derived_from pointer; the missing parent ids live in
   * `orphanRefs` instead so `atomIds` stays usable as actual atom
   * identifiers.
   */
  readonly atomIds: ReadonlyArray<string>;
  /**
   * Only populated by 'orphan-provenance'. Pairs the child atom
   * with the parent id it references but the store cannot resolve.
   */
  readonly orphanRefs?: ReadonlyArray<{
    readonly childId: string;
    readonly missingParentId: string;
  }>;
}

/**
 * Run the auditor against the live atom store. Writes:
 *   - one `observation` atom (L1) carrying the findings summary and
 *     metrics; correlation_id in metadata.audit.correlation_id
 *   - one `actor-message` atom from auditor-actor to the payload's
 *     `reply_to` principal, summarizing findings
 *
 * Returns InvokeResult.completed with both atom ids.
 */
export async function runAuditor(
  host: Host,
  payload: AuditorPayload,
  correlationId: string,
  options: { readonly principalId?: PrincipalId; readonly now?: () => number } = {},
): Promise<InvokeResult> {
  const auditorPrincipal = options.principalId ?? ('auditor-actor' as PrincipalId);
  const now = options.now ?? (() => Date.now());
  const nowIso = new Date(now()).toISOString() as Time;

  // Scan: page through matching atoms with both the adapter filter
  // AND an in-code re-scope. `superseded: true` is load-bearing
  // because the default query excludes superseded atoms but the
  // auditor reports on them.
  //
  // Why page instead of one 2000-row fetch: AtomFilter enforcement
  // varies across adapters (a predicate may silently no-op on some
  // backing stores). If the backing store ignored principal_id and
  // the first 2000 rows were all out-of-scope, a scoped audit would
  // report clean while matching atoms sat on later pages. We page
  // until exhaustion or a hard cap (MAX_SCAN) to bound the worst
  // case; if the cap trips the result is marked as `is_sample:true`
  // so the operator sees the audit was bounded, not exhaustive.
  const MAX_SCAN = 10_000;
  const PAGE_SIZE = 2000;
  const filter = {
    superseded: true,
    ...(payload.filter?.principal_id ? { principal_id: [payload.filter.principal_id] } : {}),
    ...(payload.filter?.type && payload.filter.type.length > 0
      ? { type: [...payload.filter.type] }
      : {}),
  };

  const inScope = (atom: Atom) =>
    (!payload.filter?.principal_id
      || String(atom.principal_id) === String(payload.filter.principal_id))
    && (!payload.filter?.type
      || payload.filter.type.length === 0
      || payload.filter.type.includes(atom.type));

  const scopedAtoms: Atom[] = [];
  let totalRowsSeen = 0;
  let cursor: string | undefined;
  let isSample = false;
  do {
    const remaining = MAX_SCAN - totalRowsSeen;
    if (remaining <= 0) {
      isSample = true;
      break;
    }
    // Size this page against the remaining budget so the loop cannot
    // exceed MAX_SCAN by an extra page of rows. Without this, the
    // upper-bound check runs AFTER consuming a full PAGE_SIZE, so
    // the cap can be breached by up to PAGE_SIZE-1 rows.
    const thisPageLimit = Math.min(PAGE_SIZE, remaining);
    const page = await host.atoms.query(filter, thisPageLimit, cursor);
    for (const atom of page.atoms) {
      if (inScope(atom)) scopedAtoms.push(atom);
    }
    totalRowsSeen += page.atoms.length;
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
    if (totalRowsSeen >= MAX_SCAN) {
      isSample = true;
      break;
    }
  } while (cursor !== undefined);

  const findings = await collectFindings(host, scopedAtoms);
  const counts = {
    scanned: scopedAtoms.length,
    rows_seen: totalRowsSeen,
    is_sample: isSample,
    tainted: scopedAtoms.filter((a) => a.taint !== 'clean').length,
    superseded: scopedAtoms.filter((a) => a.superseded_by.length > 0).length,
    open_circuit_breaker_trips: scopedAtoms.filter(
      (a) => a.type === 'circuit-breaker-trip' && a.superseded_by.length === 0,
    ).length,
    by_severity: {
      info: findings.filter((f) => f.severity === 'info').length,
      warn: findings.filter((f) => f.severity === 'warn').length,
      critical: findings.filter((f) => f.severity === 'critical').length,
    },
  };

  // Write the observation atom.
  const observationId = `audit-obs-${correlationId}-${now()}` as unknown as AtomId;
  const observationAtom: Atom = {
    schema_version: 1,
    id: observationId,
    content:
      `Audit findings (${findings.length} items; ${counts.scanned} atoms scanned). `
      + `Severity: ${counts.by_severity.critical} critical, ${counts.by_severity.warn} warn, `
      + `${counts.by_severity.info} info.`,
    type: 'observation',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: { tool: 'auditor-actor', agent_id: String(auditorPrincipal), session_id: correlationId },
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
    principal_id: auditorPrincipal,
    taint: 'clean',
    metadata: {
      audit: {
        correlation_id: correlationId,
        counts,
        // Cap BOTH the number of findings AND the number of atomIds
        // per finding. A single tainted-atoms / orphan-provenance
        // entry can legitimately list thousands of ids; serializing
        // them all blows up the observation atom's size for no
        // operator value. The omitted_atom_ids counter lets a
        // consumer re-query for the full list if needed.
        findings: findings.slice(0, 50).map((f) => {
          const cappedIds = f.atomIds.slice(0, 50);
          const cappedRefs = f.orphanRefs ? f.orphanRefs.slice(0, 50) : undefined;
          const omittedIds = f.atomIds.length - cappedIds.length;
          const omittedRefs = f.orphanRefs
            ? f.orphanRefs.length - (cappedRefs?.length ?? 0)
            : 0;
          const base: AuditFinding & {
            omitted_atom_ids?: number;
            omitted_orphan_refs?: number;
          } = {
            ...f,
            atomIds: cappedIds,
            ...(cappedRefs !== undefined ? { orphanRefs: cappedRefs } : {}),
          };
          if (omittedIds > 0) base.omitted_atom_ids = omittedIds;
          if (omittedRefs > 0) base.omitted_orphan_refs = omittedRefs;
          return base;
        }),
      },
    },
  };
  await host.atoms.put(observationAtom);

  // Write the reply actor-message.
  const replyId = `audit-reply-${correlationId}-${now()}` as unknown as AtomId;
  const urgency: UrgencyTier = counts.by_severity.critical > 0 ? 'high' : 'normal';
  const replyEnvelope: ActorMessageV1 = {
    to: payload.reply_to,
    from: auditorPrincipal,
    topic: 'audit-report',
    urgency_tier: urgency,
    body: renderAuditBody(findings, counts),
    correlation_id: correlationId,
  };
  const replyAtom: Atom = {
    schema_version: 1,
    id: replyId,
    content: replyEnvelope.body,
    type: 'actor-message',
    layer: 'L0',
    provenance: {
      kind: 'agent-observed',
      source: {
        tool: 'auditor-actor',
        agent_id: String(auditorPrincipal),
        session_id: correlationId,
      },
      derived_from: [observationId],
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
    principal_id: auditorPrincipal,
    taint: 'clean',
    metadata: { actor_message: replyEnvelope },
  };
  await host.atoms.put(replyAtom);

  return {
    kind: 'completed',
    producedAtomIds: [String(observationId), String(replyId)],
    summary:
      `auditor-actor completed: ${findings.length} findings (`
      + `${counts.by_severity.critical} critical, `
      + `${counts.by_severity.warn} warn, `
      + `${counts.by_severity.info} info) across ${counts.scanned} atoms.`,
  };
}

/**
 * Deterministic finding collection. Checks a small set of
 * governance invariants:
 * - Tainted atoms (all taints surface as warn).
 * - Open circuit-breaker trips (warn).
 * - Atoms derived_from an id that does not exist in the store at
 *   all (critical; provenance-chain break). An id that's simply
 *   outside the scanned slice but present in the store is NOT a
 *   finding: a bounded scan cannot assume all parents of every
 *   scanned atom are in-slice. The store is queried explicitly
 *   (host.atoms.get) for each candidate orphan before flagging.
 */
async function collectFindings(
  host: Host,
  atoms: ReadonlyArray<Atom>,
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const ids = new Set(atoms.map((a) => String(a.id)));

  const tainted = atoms.filter((a) => a.taint !== 'clean');
  if (tainted.length > 0) {
    findings.push({
      severity: 'warn',
      kind: 'tainted-atoms',
      detail: `${tainted.length} atoms carry taint != 'clean'.`,
      atomIds: tainted.map((a) => String(a.id)),
    });
  }

  const openTrips = atoms.filter(
    (a) => a.type === 'circuit-breaker-trip' && a.superseded_by.length === 0,
  );
  if (openTrips.length > 0) {
    findings.push({
      severity: 'warn',
      kind: 'open-circuit-breaker-trips',
      detail: `${openTrips.length} unresolved circuit-breaker-trip atoms.`,
      atomIds: openTrips.map((a) => String(a.id)),
    });
  }

  // Orphan provenance: verify each missing-in-slice parent really
  // doesn't exist in the store. An in-slice miss + out-of-store
  // means broken chain (critical); an in-slice miss + in-store hit
  // is just the scope boundary (not a finding).
  //
  // Output shape: `atomIds` holds the CHILD ids (valid atom ids you
  // can host.atoms.get). The missing-parent side of the edge lives
  // in a parallel `orphanRefs` array so the AuditFinding contract
  // stays clean: atomIds are always real atom ids.
  const orphanRefs: Array<{ childId: string; missingParentId: string }> = [];
  const checked = new Map<string, boolean>(); // parentId -> exists
  for (const atom of atoms) {
    for (const parentId of atom.provenance.derived_from) {
      const pid = String(parentId);
      if (ids.has(pid)) continue;
      let exists = checked.get(pid);
      if (exists === undefined) {
        const resolved = await host.atoms.get(parentId);
        exists = resolved !== null;
        checked.set(pid, exists);
      }
      if (!exists) {
        orphanRefs.push({ childId: String(atom.id), missingParentId: pid });
      }
    }
  }
  if (orphanRefs.length > 0) {
    // Children may appear multiple times (multiple missing parents);
    // dedupe for atomIds so the list stays usable.
    const childIds = Array.from(new Set(orphanRefs.map((r) => r.childId)));
    findings.push({
      severity: 'critical',
      kind: 'orphan-provenance',
      detail:
        `${orphanRefs.length} broken provenance edge(s) across ${childIds.length} atom(s). `
        + 'The referenced parent atoms do not exist anywhere in the store; '
        + 'the provenance chain is broken and must be repaired.',
      atomIds: childIds,
      orphanRefs,
    });
  }

  return findings;
}

function renderAuditBody(findings: AuditFinding[], counts: Record<string, unknown>): string {
  if (findings.length === 0) {
    return `Audit clean: 0 findings across the scanned slice.\n\nCounts: ${JSON.stringify(counts)}`;
  }
  const lines = [`Audit produced ${findings.length} findings.`, '', 'Findings:'];
  for (const f of findings) {
    lines.push(`- [${f.severity}] ${f.kind}: ${f.detail}`);
  }
  lines.push('', `Counts: ${JSON.stringify(counts)}`);
  return lines.join('\n');
}
