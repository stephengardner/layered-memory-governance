/**
 * Canon policy parsers for the deep planning pipeline.
 *
 * Each reader walks directive atoms tagged with a known subject,
 * fail-closes on malformed shapes, and returns the highest-priority
 * match for the requested scope.
 *
 * Mechanism-only: this module reads policy atoms; the policy CONTENT
 * lives in canon, not here.
 */

import type { Host } from '../../substrate/interface.js';
import type { Atom } from '../../substrate/types.js';

const MAX_SCAN = 5_000;
const PAGE_SIZE = 200;

export interface StageDescriptor {
  readonly name: string;
  readonly principal_id: string;
}

export interface PipelineStagesPolicyResult {
  readonly stages: ReadonlyArray<StageDescriptor>;
  readonly atomId: string | null;
}

export interface PipelineStageHilPolicyResult {
  readonly pause_mode: 'always' | 'on-critical-finding' | 'never';
  readonly auto_resume_after_ms: number | null;
  readonly allowed_resumers: ReadonlyArray<string>;
}

export interface PipelineDefaultModePolicyResult {
  readonly mode: 'single-pass' | 'substrate-deep';
}

export interface PipelineStageCostCapPolicyResult {
  readonly cap_usd: number | null;
}

/** Modes a stage adapter can be selected as. */
export type PipelineStageImplementationMode = 'agentic' | 'single-shot';

export interface PipelineStageImplementationsPolicyResult {
  /**
   * Map of stage_name to selected adapter mode. A stage absent from the
   * map has no canon selection; the caller applies its own default for
   * absent entries.
   */
  readonly implementations: ReadonlyMap<string, PipelineStageImplementationMode>;
  readonly atomId: string | null;
}

async function* iteratePolicyAtoms(host: Host): AsyncGenerator<Atom> {
  let totalSeen = 0;
  let cursor: string | undefined;
  do {
    const remaining = MAX_SCAN - totalSeen;
    if (remaining <= 0) break;
    const page = await host.atoms.query(
      { type: ['directive'], layer: ['L3'] },
      Math.min(PAGE_SIZE, remaining),
      cursor,
    );
    for (const atom of page.atoms) {
      if (atom.taint !== 'clean') continue;
      if (atom.superseded_by.length > 0) continue;
      yield atom;
    }
    totalSeen += page.atoms.length;
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);
}

function readPolicy(atom: Atom): Record<string, unknown> | null {
  const meta = (atom.metadata as Record<string, unknown>) ?? {};
  const policy = meta.policy;
  return policy && typeof policy === 'object' ? (policy as Record<string, unknown>) : null;
}

/**
 * Source-rank short-circuit depth used as a v1 emulation when
 * host.canon.applicable is unavailable. Higher depth wins; a
 * principal-scoped atom beats a feature-scoped atom beats a
 * project-scoped atom.
 */
function scopeDepth(policyScope: unknown): number {
  if (typeof policyScope !== 'string') return 0;
  if (policyScope.startsWith('principal:')) return 2;
  if (policyScope.startsWith('feature:')) return 1;
  return 0;
}

/**
 * Determine whether a policy scope applies to the requested ctx scope.
 *
 * Project policy ('project') applies to every scope.
 * Feature/principal policies ('feature:<id>' / 'principal:<id>') apply
 * only when ctx.scope matches the same prefix-and-id form, so a
 * principal:foo policy does not leak into a principal:bar query.
 */
function scopeApplies(policyScope: unknown, ctxScope: string): boolean {
  if (typeof policyScope !== 'string') return false;
  if (policyScope === 'project') return true;
  return policyScope === ctxScope;
}

export async function readPipelineStagesPolicy(
  host: Host,
  ctx: { readonly scope: string },
): Promise<PipelineStagesPolicyResult> {
  let best: { atom: Atom; depth: number } | null = null;
  for await (const atom of iteratePolicyAtoms(host)) {
    const policy = readPolicy(atom);
    if (policy?.subject !== 'planning-pipeline-stages') continue;
    if (!scopeApplies(policy.scope, ctx.scope)) continue;
    const depth = scopeDepth(policy.scope);
    if (best === null || depth > best.depth) best = { atom, depth };
  }
  if (best === null) return { stages: [], atomId: null };
  const policy = readPolicy(best.atom);
  if (policy === null) return { stages: [], atomId: null };
  const rawStages = policy.stages;
  if (!Array.isArray(rawStages)) return { stages: [], atomId: String(best.atom.id) };
  const stages: StageDescriptor[] = [];
  const seen = new Set<string>();
  for (const entry of rawStages) {
    if (entry === null || typeof entry !== 'object') {
      return { stages: [], atomId: String(best.atom.id) };
    }
    const obj = entry as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name : null;
    const principal_id = typeof obj.principal_id === 'string' ? obj.principal_id : null;
    if (name === null || principal_id === null) {
      return { stages: [], atomId: String(best.atom.id) };
    }
    if (seen.has(name)) {
      return { stages: [], atomId: String(best.atom.id) };
    }
    seen.add(name);
    stages.push({ name, principal_id });
  }
  return { stages, atomId: String(best.atom.id) };
}

export async function readPipelineStageHilPolicy(
  host: Host,
  stageName: string,
): Promise<PipelineStageHilPolicyResult> {
  for await (const atom of iteratePolicyAtoms(host)) {
    const policy = readPolicy(atom);
    if (policy?.subject !== 'pipeline-stage-hil') continue;
    if (policy.stage_name !== stageName) continue;
    const rawMode = policy.pause_mode;
    const mode: PipelineStageHilPolicyResult['pause_mode'] =
      rawMode === 'always' || rawMode === 'on-critical-finding' || rawMode === 'never'
        ? rawMode
        : 'always';
    const autoResume =
      typeof policy.auto_resume_after_ms === 'number'
      && Number.isFinite(policy.auto_resume_after_ms)
      && policy.auto_resume_after_ms >= 0
        ? policy.auto_resume_after_ms
        : null;
    const allowed = Array.isArray(policy.allowed_resumers)
      ? (policy.allowed_resumers as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];
    return { pause_mode: mode, auto_resume_after_ms: autoResume, allowed_resumers: allowed };
  }
  // Fail-closed default: when no policy atom matches, pause for HIL rather
  // than silently advancing. Operator-authored policy atoms widen this to
  // 'on-critical-finding' or 'never' per dev-governance-before-autonomy.
  return { pause_mode: 'always', auto_resume_after_ms: null, allowed_resumers: [] };
}

export async function readPipelineDefaultModePolicy(
  host: Host,
): Promise<PipelineDefaultModePolicyResult> {
  for await (const atom of iteratePolicyAtoms(host)) {
    const policy = readPolicy(atom);
    if (policy?.subject !== 'planning-pipeline-default-mode') continue;
    const raw = policy.mode;
    if (raw === 'substrate-deep' || raw === 'single-pass') return { mode: raw };
  }
  return { mode: 'single-pass' };
}

export async function readPipelineStageCostCapPolicy(
  host: Host,
  stageName: string,
): Promise<PipelineStageCostCapPolicyResult> {
  for await (const atom of iteratePolicyAtoms(host)) {
    const policy = readPolicy(atom);
    if (policy?.subject !== 'pipeline-stage-cost-cap') continue;
    if (policy.stage_name !== stageName) continue;
    const cap = policy.cap_usd;
    if (typeof cap === 'number' && Number.isFinite(cap) && cap > 0) return { cap_usd: cap };
  }
  return { cap_usd: null };
}

/**
 * Read the per-stage implementation-mode policy and return a map of
 * stage_name to 'agentic' | 'single-shot'.
 *
 * Intentionally separate from readPipelineStagesPolicy: the stages
 * reader resolves WHICH stages run in WHAT order; this reader resolves
 * WHICH adapter IMPLEMENTATION runs each stage. Conflating them would
 * couple two independent canon dimensions: a deployment that wants to
 * keep the default stage ordering but flip one stage's adapter mode
 * would have to reproduce the entire stage list to alter the mode.
 *
 * Fail-closed: malformed entries collapse to an empty map. The caller
 * decides the default mode for stages absent from the returned map.
 */
export async function readPipelineStageImplementationsPolicy(
  host: Host,
  ctx: { readonly scope: string },
): Promise<PipelineStageImplementationsPolicyResult> {
  let best: { atom: Atom; depth: number } | null = null;
  for await (const atom of iteratePolicyAtoms(host)) {
    const policy = readPolicy(atom);
    if (policy?.subject !== 'planning-pipeline-stage-implementations') continue;
    if (!scopeApplies(policy.scope, ctx.scope)) continue;
    const depth = scopeDepth(policy.scope);
    if (best === null || depth > best.depth) best = { atom, depth };
  }
  const empty: ReadonlyMap<string, PipelineStageImplementationMode> = new Map();
  if (best === null) return { implementations: empty, atomId: null };
  const policy = readPolicy(best.atom);
  if (policy === null) return { implementations: empty, atomId: null };
  const rawImpls = policy.implementations;
  if (!Array.isArray(rawImpls)) {
    return { implementations: empty, atomId: String(best.atom.id) };
  }
  const out = new Map<string, PipelineStageImplementationMode>();
  for (const entry of rawImpls) {
    if (entry === null || typeof entry !== 'object') {
      return { implementations: empty, atomId: String(best.atom.id) };
    }
    const obj = entry as Record<string, unknown>;
    const stageName = typeof obj.stage_name === 'string' ? obj.stage_name : null;
    const rawMode = obj.mode;
    const mode: PipelineStageImplementationMode | null =
      rawMode === 'agentic' || rawMode === 'single-shot' ? rawMode : null;
    if (stageName === null || mode === null) {
      return { implementations: empty, atomId: String(best.atom.id) };
    }
    if (out.has(stageName)) {
      return { implementations: empty, atomId: String(best.atom.id) };
    }
    out.set(stageName, mode);
  }
  return { implementations: out, atomId: String(best.atom.id) };
}
