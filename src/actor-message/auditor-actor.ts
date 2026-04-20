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

import type { Host } from '../interface.js';
import type { Atom, AtomId, PrincipalId, Time } from '../types.js';
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
    readonly type?: ReadonlyArray<string>;
  };
}

export interface AuditFinding {
  readonly severity: 'info' | 'warn' | 'critical';
  readonly kind: string;
  readonly detail: string;
  readonly atomIds: ReadonlyArray<string>;
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

  // Scan: pull a bounded slice of atoms matching the filter. The
  // auditor is not designed to walk an unbounded store; at scale
  // the operator chunks audits via smaller filters. Both
  // principal_id AND type from the payload flow into the query so
  // type-scoped audits do not silently fan out to the whole store.
  const page = await host.atoms.query({
    ...(payload.filter?.principal_id ? { principal_id: [payload.filter.principal_id] } : {}),
    ...(payload.filter?.type && payload.filter.type.length > 0
      ? { type: [...payload.filter.type] as Atom['type'][] }
      : {}),
  }, 2000);

  const findings = await collectFindings(host, page.atoms);
  const counts = {
    scanned: page.atoms.length,
    tainted: page.atoms.filter((a) => a.taint !== 'clean').length,
    superseded: page.atoms.filter((a) => a.superseded_by.length > 0).length,
    open_circuit_breaker_trips: page.atoms.filter(
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
        findings: findings.slice(0, 50), // bound the serialized size
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
  const orphanProvenance: string[] = [];
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
        orphanProvenance.push(`${String(atom.id)}->${pid}`);
      }
    }
  }
  if (orphanProvenance.length > 0) {
    findings.push({
      severity: 'critical',
      kind: 'orphan-provenance',
      detail:
        `${orphanProvenance.length} atoms reference a provenance.derived_from id `
        + 'that does not exist anywhere in the atom store. The provenance chain '
        + 'is broken and must be repaired.',
      atomIds: orphanProvenance,
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
