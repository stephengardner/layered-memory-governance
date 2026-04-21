/**
 * LAG Console backend server.
 *
 * Reads actual `.lag/atoms/` JSON files from the repo root (two
 * levels up from apps/console/server) and serves them over a tiny
 * HTTP + SSE API. Intentionally a Node-http-only server with no
 * dependencies — simpler than express, starts instantly, and the
 * surface area is small enough that an SSE event stream slots in
 * cleanly for future realtime canon updates.
 *
 * All endpoints return a uniform envelope:
 *   { ok: true, data: T }
 *   { ok: false, error: { code, message } }
 *
 * Dotted method names map to URL segments (POST /api/canon.list etc.)
 * so the transport contract is uniform whether the frontend runs in
 * a browser (v1, this server) or a Tauri webview (v2, Rust handlers).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { watch as fsWatch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  atomFilenameFromId,
  isAllowedOrigin as isAllowedOriginPure,
  makeAllowedOriginSet,
} from './security';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONSOLE_ROOT = resolve(HERE, '..');
const APPS_ROOT = resolve(CONSOLE_ROOT, '..');
const REPO_ROOT = resolve(APPS_ROOT, '..');

// Resolving `.lag/` path:
// 1. LAG_CONSOLE_LAG_DIR env var takes precedence (lets a worktree
//    backend read from a sibling checkout's `.lag/`, or point at a
//    fixture directory for tests).
// 2. Fall back to `<repo-root>/.lag/` which works for the default
//    single-checkout case.
const LAG_DIR = process.env.LAG_CONSOLE_LAG_DIR
  ? resolve(process.env.LAG_CONSOLE_LAG_DIR)
  : resolve(REPO_ROOT, '.lag');
const ATOMS_DIR = join(LAG_DIR, 'atoms');
const PRINCIPALS_DIR = join(LAG_DIR, 'principals');

const PORT = Number.parseInt(process.env.LAG_CONSOLE_BACKEND_PORT ?? '9081', 10);

// ---------------------------------------------------------------------------
// Atom types (re-declared here so server + frontend stay decoupled).
// ---------------------------------------------------------------------------

interface Atom {
  id: string;
  type: string;
  layer: string;
  content: string;
  principal_id: string;
  confidence: number;
  created_at: string;
  metadata?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  taint?: string;
  superseded_by?: string[];
  supersedes?: string[];
}

interface Principal {
  id: string;
  name?: string;
  role?: string;
  active?: boolean;
  signed_by?: string | null;
  compromised_at?: string | null;
  created_at?: string;
  permitted_scopes?: { read?: string[]; write?: string[] };
  permitted_layers?: { read?: string[]; write?: string[] };
  goals?: string[];
  constraints?: string[];
}

// ---------------------------------------------------------------------------
// In-memory atom index.
//
// Source of truth stays on disk (`.lag/atoms/*.json`) per canon
// `arch-atomstore-source-of-truth`. The index is a PROJECTION that
// the server maintains to avoid O(N disk reads) on every API call.
// At 50 actors writing 30k atoms/hour (the ceiling the canon
// aspires to per `dev-indie-floor-org-ceiling`), the old
// readdir+readFile-per-request pattern would collapse; this moves
// us to O(1) reads and O(1) writes with the file-watcher as the
// cache-invalidation signal.
//
// Coherence rules:
//   - On startup, prime the cache by reading everything once.
//   - On `atom.created` / `atom.changed` events from the watcher,
//     refresh that single file (re-read JSON, update the map).
//   - On `atom.deleted`, drop the map entry.
//   - All read handlers read from `atomIndex.values()` — never hit
//     the disk on the hot path.
//
// The map key is the filename (e.g. `arch-host-interface-boundary.json`)
// so we can correlate watcher events to entries in O(1).
// ---------------------------------------------------------------------------

const atomIndex = new Map<string, Atom>();
let atomIndexPrimed = false;

async function refreshAtomInIndex(filename: string): Promise<void> {
  try {
    const raw = await readFile(join(ATOMS_DIR, filename), 'utf8');
    const parsed = JSON.parse(raw) as Atom;
    atomIndex.set(filename, parsed);
  } catch (err) {
    // File may have been deleted between watcher event and our read.
    // Drop it from the index; next listing will skip it.
    atomIndex.delete(filename);
    console.warn(`[backend] dropping ${filename}: ${(err as Error).message}`);
  }
}

async function primeAtomIndex(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(ATOMS_DIR);
  } catch (err) {
    console.error(`[backend] could not read ${ATOMS_DIR}: ${(err as Error).message}`);
    atomIndexPrimed = true;
    return;
  }
  const files = entries.filter((n) => n.endsWith('.json'));
  // Parallel reads — startup cost is bounded by disk, not sequential I/O.
  await Promise.all(files.map((f) => refreshAtomInIndex(f)));
  atomIndexPrimed = true;
  console.log(`[backend] atom index primed with ${atomIndex.size} entries`);
}

async function readAllAtoms(): Promise<Atom[]> {
  // If the index isn't primed yet (extremely early requests before
  // startAtomWatcher resolves), fall back to a fresh disk read so
  // first-request correctness is preserved. This only runs for the
  // narrow startup window.
  if (!atomIndexPrimed) {
    let entries: string[];
    try {
      entries = await readdir(ATOMS_DIR);
    } catch {
      return [];
    }
    const files = entries.filter((n) => n.endsWith('.json'));
    const atoms: Atom[] = [];
    for (const name of files) {
      try {
        const raw = await readFile(join(ATOMS_DIR, name), 'utf8');
        atoms.push(JSON.parse(raw) as Atom);
      } catch { /* skip malformed */ }
    }
    return atoms;
  }
  return Array.from(atomIndex.values());
}

function filterCanon(atoms: Atom[], params: { types?: string[]; search?: string }): Atom[] {
  let out = atoms.filter((a) => a.layer === 'L3');
  // Non-superseded only: any atom with a non-empty superseded_by array
  // has been replaced by a newer version and should not show as live.
  out = out.filter((a) => !a.superseded_by || a.superseded_by.length === 0);
  // Taint filter: only clean atoms render as canon.
  out = out.filter((a) => !a.taint || a.taint === 'clean');
  if (params.types && params.types.length > 0) {
    const set = new Set(params.types);
    out = out.filter((a) => set.has(a.type));
  }
  if (params.search && params.search.length > 0) {
    const needle = params.search.toLowerCase();
    out = out.filter(
      (a) =>
        a.content.toLowerCase().includes(needle)
        || a.id.toLowerCase().includes(needle),
    );
  }
  /*
   * Sort by created_at DESC (newest first) so freshly-proposed and
   * recently-reinforced canon lands at the top. Ties fall back to
   * type then id for determinism. Previous ordering was type+id
   * alphabetical which is stable but puts architecture atoms
   * (arch-*) before development atoms (dev-*) regardless of when
   * they were written — bad for scanning "what's new".
   */
  out.sort((a, b) => {
    const tb = (b.created_at ?? '');
    const ta = (a.created_at ?? '');
    if (tb !== ta) return tb.localeCompare(ta);
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.id.localeCompare(b.id);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Tiny request utilities.
// ---------------------------------------------------------------------------

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (body.length === 0) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(body) as Record<string, unknown>);
      } catch (err) {
        rejectPromise(err);
      }
    });
    req.on('error', rejectPromise);
  });
}

/*
 * CORS allowlist is built once at boot from the in-repo defaults
 * plus an optional env extra list. Pure construction + lookup lives
 * in ./security so it can be unit-tested without standing up the
 * HTTP server.
 */
const ALLOWED_ORIGINS = makeAllowedOriginSet(process.env['LAG_CONSOLE_ALLOWED_ORIGINS']);

function isAllowedOrigin(origin: string | undefined): boolean {
  return isAllowedOriginPure(ALLOWED_ORIGINS, origin);
}

function corsHeadersFor(req: IncomingMessage | undefined): Record<string, string> {
  const origin = req?.headers.origin;
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
  };
  if (typeof origin === 'string' && ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function sendJson(req: IncomingMessage | undefined, res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...corsHeadersFor(req),
  });
  res.end(JSON.stringify(payload));
}

function sendOk<T>(req: IncomingMessage, res: ServerResponse, data: T): void {
  sendJson(req, res, 200, { ok: true, data });
}

function sendErr(req: IncomingMessage, res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(req, res, status, { ok: false, error: { code, message } });
}

// ---------------------------------------------------------------------------
// Handlers.
// ---------------------------------------------------------------------------

async function handleCanonList(params: { types?: string[]; search?: string }): Promise<Atom[]> {
  const all = await readAllAtoms();
  return filterCanon(all, params);
}

async function handleCanonStats(): Promise<{ total: number; byType: Record<string, number> }> {
  const all = await readAllAtoms();
  const filtered = filterCanon(all, {});
  const byType: Record<string, number> = {};
  for (const a of filtered) byType[a.type] = (byType[a.type] ?? 0) + 1;
  return { total: filtered.length, byType };
}

async function readAllPrincipals(): Promise<Principal[]> {
  let entries: string[];
  try {
    entries = await readdir(PRINCIPALS_DIR);
  } catch (err) {
    console.error(`[backend] could not read ${PRINCIPALS_DIR}: ${(err as Error).message}`);
    return [];
  }
  const files = entries.filter((n) => n.endsWith('.json'));
  const out: Principal[] = [];
  for (const name of files) {
    try {
      const raw = await readFile(join(PRINCIPALS_DIR, name), 'utf8');
      out.push(JSON.parse(raw) as Principal);
    } catch (err) {
      console.warn(`[backend] skipping malformed principal ${name}: ${(err as Error).message}`);
    }
  }
  // Stable: root principals first, then by id.
  out.sort((a, b) => {
    const aRoot = !a.signed_by ? 0 : 1;
    const bRoot = !b.signed_by ? 0 : 1;
    if (aRoot !== bRoot) return aRoot - bRoot;
    return a.id.localeCompare(b.id);
  });
  return out;
}

async function handlePrincipalsList(): Promise<Principal[]> {
  return readAllPrincipals();
}

/*
 * Activities = recent atoms across all types, sorted by created_at
 * desc. Includes non-L3 atoms (observations, actor-messages, plans,
 * questions) because the point is to show what's HAPPENING, not
 * just live canon.
 */
async function handleActivitiesList(params: { limit?: number; types?: string[] }): Promise<Atom[]> {
  const all = await readAllAtoms();
  let out = all.filter((a) => !a.superseded_by || a.superseded_by.length === 0);
  if (params.types && params.types.length > 0) {
    const set = new Set(params.types);
    out = out.filter((a) => set.has(a.type));
  }
  out.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  const limit = Math.max(1, Math.min(500, params.limit ?? 100));
  return out.slice(0, limit);
}

/*
 * Plans = atoms of type 'plan' OR atoms whose top-level `plan_state`
 * field is present (arch-plan-state-top-level-field).
 */
/*
 * Reverse refs = every atom whose provenance or metadata points AT
 * the given id. Lets the UI surface "this atom is referenced by..."
 * on any card — turns the derived_from graph bidirectional.
 */
async function handleAtomReferences(id: string): Promise<Atom[]> {
  const all = await readAllAtoms();
  return all.filter((a) => {
    if (a.id === id) return false;
    const derived = (a.provenance as { derived_from?: string[] } | undefined)?.derived_from ?? [];
    const meta = a.metadata ?? {};
    const sourcePlan = typeof meta['source_plan'] === 'string' ? meta['source_plan'] : undefined;
    return (
      derived.includes(id)
      || (a.supersedes ?? []).includes(id)
      || (a.superseded_by ?? []).includes(id)
      || sourcePlan === id
    );
  });
}

/*
 * Daemon status summary: the lightest useful digest of what's
 * happening in .lag/. Computed from atom metadata — no log file
 * scraping, no external dep. The Console header pill renders this
 * into a single live/quiet badge.
 */
/*
 * Provenance walk: starting at `id`, follow derived_from pointers
 * transitively and return the chain of ancestor atoms. Depth-limited
 * (default 5) and cycle-safe via a visited set.
 */
async function handleAtomChain(id: string, maxDepth: number): Promise<Atom[]> {
  const all = await readAllAtoms();
  const byId = new Map(all.map((a) => [a.id, a]));
  const visited = new Set<string>();
  const chain: Atom[] = [];
  const queue: Array<{ id: string; depth: number }> = [{ id, depth: 0 }];
  while (queue.length > 0) {
    const { id: cur, depth } = queue.shift()!;
    if (visited.has(cur) || depth > maxDepth) continue;
    visited.add(cur);
    const atom = byId.get(cur);
    if (!atom) continue;
    if (cur !== id) chain.push(atom);
    const derived = (atom.provenance as { derived_from?: string[] } | undefined)?.derived_from ?? [];
    for (const next of derived) queue.push({ id: next, depth: depth + 1 });
  }
  return chain;
}

/*
 * Taint cascade: if the given atom (or principal) were marked
 * compromised/tainted, which atoms would transitively inherit taint?
 * Walks the REVERSE direction of derived_from — atoms that point AT
 * this one, and atoms that point at those.
 */
async function handleAtomCascade(id: string, maxDepth: number): Promise<Atom[]> {
  const all = await readAllAtoms();
  const referencers = new Map<string, string[]>();
  for (const a of all) {
    const derived = (a.provenance as { derived_from?: string[] } | undefined)?.derived_from ?? [];
    for (const d of derived) {
      const bucket = referencers.get(d);
      if (bucket) bucket.push(a.id); else referencers.set(d, [a.id]);
    }
  }
  const byId = new Map(all.map((a) => [a.id, a]));
  const visited = new Set<string>([id]);
  const cascade: Atom[] = [];
  const queue: Array<{ id: string; depth: number }> = [{ id, depth: 0 }];
  while (queue.length > 0) {
    const { id: cur, depth } = queue.shift()!;
    if (depth > maxDepth) continue;
    const refs = referencers.get(cur) ?? [];
    for (const r of refs) {
      if (visited.has(r)) continue;
      visited.add(r);
      const atom = byId.get(r);
      if (atom) cascade.push(atom);
      queue.push({ id: r, depth: depth + 1 });
    }
  }
  return cascade;
}

/*
 * Source-rank formula per canon pref-source-rank-scoring-formula:
 *   Layer x 10000 + Provenance x 100 + (MAX_PRINCIPAL_DEPTH - depth) x 10
 *     + floor(confidence x 10)
 *
 * We don't have principal_depth data here yet, so this implementation
 * approximates depth=0 for human, 1 for agent-signed-by-human, etc.,
 * derived from the principals file if present. If data is missing,
 * the formula still ranks reasonably by layer + confidence.
 */
/*
 * Drift / staleness report: canon atoms whose last_reinforced_at is
 * older than 90 days OR whose expires_at is within 30 days OR whose
 * confidence dropped below 0.7. Health surface: the operator sees
 * which canon needs re-validation at a glance.
 */
async function handleDriftReport(): Promise<{
  stale: Atom[];
  expiring: Atom[];
  lowConfidence: Atom[];
}> {
  const all = await readAllAtoms();
  const canon = all.filter((a) => a.layer === 'L3' && (!a.superseded_by || a.superseded_by.length === 0) && (!a.taint || a.taint === 'clean'));
  const now = Date.now();
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const stale: Atom[] = [];
  const expiring: Atom[] = [];
  const lowConfidence: Atom[] = [];
  for (const a of canon) {
    const last = (a as unknown as { last_reinforced_at?: string }).last_reinforced_at ?? a.created_at;
    const lastTs = last ? Date.parse(last) : NaN;
    if (Number.isFinite(lastTs) && (now - lastTs) > ninetyDaysMs) stale.push(a);
    const exp = (a as unknown as { expires_at?: string | null }).expires_at;
    if (exp) {
      const expTs = Date.parse(exp);
      if (Number.isFinite(expTs) && (expTs - now) < thirtyDaysMs && expTs > now) expiring.push(a);
    }
    if (typeof a.confidence === 'number' && a.confidence < 0.7) lowConfidence.push(a);
  }
  return { stale, expiring, lowConfidence };
}

/*
 * Canon applicable: given a principal + layer + scope, return the
 * canon atoms that govern that position, sorted by source-rank per
 * canon `pref-source-rank-scoring-formula`.
 *
 * This is the AGENT-CONSUMABLE facet the backend has been in denial
 * about. Today, agents reach into .lag/atoms/ directly and run their
 * own applicability logic. Making this an HTTP endpoint turns LAG
 * from a filesystem convention into an actual substrate with a
 * stable contract — agents query the same `/api/*` surface the UI
 * does, the server owns arbitration, and the agent code stops
 * duplicating it.
 *
 * The endpoint accepts:
 *   { principal_id: string, layer: 'L0'|'L1'|'L2'|'L3', scope?: string, atomTypes?: string[] }
 *
 * Returns atoms that:
 *   - Apply at the requested layer or higher (canon at L3 governs L0-L2)
 *   - Match the requested scope (global ⊇ project ⊇ session)
 *   - Are not tainted or superseded
 *   - Are sorted by source-rank (layer×10000 + provenance×100 + hierarchy×10 + confidence)
 */
async function handleCanonApplicable(params: {
  principal_id: string;
  layer: 'L0' | 'L1' | 'L2' | 'L3';
  scope?: string;
  atomTypes?: string[];
}): Promise<ReadonlyArray<Atom & { _rank: number }>> {
  const all = await readAllAtoms();
  const principals = await readAllPrincipals();
  const principalById = new Map(principals.map((p) => [p.id, p]));

  // Compute this principal's depth (root = 0; chain count via signed_by).
  const depth = computePrincipalDepth(params.principal_id, principalById);

  const layerOrder: Record<string, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };
  const reqLayer = layerOrder[params.layer] ?? 0;

  const scopeOrder = ['session', 'project', 'user', 'global'];
  const reqScopeIdx = params.scope ? scopeOrder.indexOf(params.scope) : 0;

  const applicable = all.filter((a) => {
    if (a.taint && a.taint !== 'clean') return false;
    if (a.superseded_by && a.superseded_by.length > 0) return false;
    const aLayer = layerOrder[a.layer] ?? 0;
    if (aLayer < reqLayer) return false; // L2 atom does not govern L3 queries
    const aScope = (a as unknown as { scope?: string }).scope ?? 'project';
    const aScopeIdx = scopeOrder.indexOf(aScope);
    // An atom's scope must be AT LEAST as wide as the requested scope.
    if (aScopeIdx < reqScopeIdx) return false;
    if (params.atomTypes && params.atomTypes.length > 0 && !params.atomTypes.includes(a.type)) return false;
    return true;
  });

  const ranked = applicable.map((a) => ({
    ...a,
    _rank: computeSourceRank(a, depth),
  }));
  ranked.sort((x, y) => y._rank - x._rank);
  return ranked;
}

function computePrincipalDepth(id: string, byId: Map<string, Principal>): number {
  // Root (no signed_by) = 0; each signed_by step adds 1. Capped at 9
  // per canon `pref-max-principal-depth`.
  let depth = 0;
  let cur: Principal | undefined = byId.get(id);
  const seen = new Set<string>();
  while (cur && cur.signed_by && !seen.has(cur.id) && depth < 9) {
    seen.add(cur.id);
    cur = byId.get(cur.signed_by);
    if (cur) depth++;
  }
  return depth;
}

function computeSourceRank(atom: Atom, principalDepth: number): number {
  // Formula per canon pref-source-rank-scoring-formula:
  //   Layer×10000 + Provenance×100 + (9 - depth)×10 + floor(confidence×10)
  const layerMap: Record<string, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };
  const layerPts = (layerMap[atom.layer] ?? 0) * 10000;

  const provKind = (atom.provenance as { kind?: string } | undefined)?.kind ?? 'unknown';
  const provMap: Record<string, number> = {
    'operator-seeded': 90,
    'user-directive': 80,
    'bootstrap': 70,
    'agent-observed': 40,
    'llm-derived': 30,
    'unknown': 10,
  };
  const provenancePts = (provMap[provKind] ?? 10) * 100;

  const MAX_DEPTH = 9;
  const hierarchyPts = Math.max(0, MAX_DEPTH - principalDepth) * 10;
  const confidencePts = Math.floor((atom.confidence ?? 0) * 10);

  return layerPts + provenancePts + hierarchyPts + confidencePts;
}

/*
 * Propose a new atom. Writes to .lag/atoms/ at L0 with
 * `validation_status: pending_review` — NEVER directly as L3 canon.
 * L3 promotion still requires the existing approval flow per canon
 * `pref-l3-threshold-default` + `inv-l3-requires-human`. This
 * endpoint is the "proposal intake"; it doesn't short-circuit the
 * gate, it opens a new door into it.
 *
 * Proposer identity comes from the request. No auth yet — single-
 * tenant local deployment. Multi-tenant deployments must wrap this
 * endpoint with auth middleware before shipping.
 */
/*
 * Reinforce / mark-stale: low-risk atom maintenance actions the
 * operator can do from the UI without touching structural fields.
 *
 * REINFORCE updates `last_reinforced_at` to now. Moves the atom out
 * of the drift banner's "stale" bucket. The canon atom itself is
 * unchanged — content, provenance, confidence all preserved. This
 * is the operator's "yes, this still applies" signal.
 *
 * MARK-STALE sets `expires_at` to now (makes the atom immediately
 * expired) AND writes metadata fields recording who did it and why.
 * The drift banner surfaces expiring/expired atoms so the operator
 * can see what they've flagged. The atom stays in canon — this is a
 * flag, not a removal. L3 supersession or retirement still goes
 * through the existing decision flow.
 *
 * Both actions preserve the atom's source-of-truth contract: they
 * update existing mutable fields on the existing on-disk JSON, they
 * do not rewrite the id/content/provenance/type.
 */
async function handleAtomReinforce(params: {
  id: string;
  actor_id: string;
}): Promise<{ id: string; last_reinforced_at: string }> {
  const filename = atomFilenameFromId(params.id);
  const raw = await readFile(join(ATOMS_DIR, filename), 'utf8');
  const atom = JSON.parse(raw) as Atom & { last_reinforced_at?: string; metadata?: Record<string, unknown> };
  const now = new Date().toISOString();
  atom.last_reinforced_at = now;
  atom.metadata = {
    ...(atom.metadata ?? {}),
    reinforced_by: params.actor_id,
    reinforced_at: now,
  };
  const fsWriteModule = await import('node:fs/promises');
  await fsWriteModule.writeFile(
    join(ATOMS_DIR, filename),
    JSON.stringify(atom, null, 2),
    'utf8',
  );
  return { id: params.id, last_reinforced_at: now };
}

async function handleAtomMarkStale(params: {
  id: string;
  actor_id: string;
  reason?: string;
}): Promise<{ id: string; expires_at: string }> {
  const filename = atomFilenameFromId(params.id);
  const raw = await readFile(join(ATOMS_DIR, filename), 'utf8');
  const atom = JSON.parse(raw) as Atom & { expires_at?: string | null; metadata?: Record<string, unknown> };
  const now = new Date().toISOString();
  atom.expires_at = now;
  atom.metadata = {
    ...(atom.metadata ?? {}),
    marked_stale_by: params.actor_id,
    marked_stale_at: now,
    ...(params.reason ? { marked_stale_reason: params.reason } : {}),
  };
  const fsWriteModule = await import('node:fs/promises');
  await fsWriteModule.writeFile(
    join(ATOMS_DIR, filename),
    JSON.stringify(atom, null, 2),
    'utf8',
  );
  return { id: params.id, expires_at: now };
}

/*
 * Kill-switch soft-tier transition from the UI. Canon constraint
 * (dec-kill-switch-design-first + inv-l3-requires-human): medium
 * and hard tiers must be CLI-gated; the UI can only flip off↔soft.
 * This endpoint enforces that at the server layer so a crafted
 * client request can't escalate beyond soft.
 */
async function handleKillSwitchTransition(params: {
  to: 'off' | 'soft';
  actor_id: string;
  reason?: string;
}): Promise<{ tier: string; since: string; reason: string | null; autonomyDial: number }> {
  if (params.to !== 'off' && params.to !== 'soft') {
    throw new Error('UI kill-switch transitions are restricted to off|soft; medium/hard require CLI per dec-kill-switch-design-first');
  }
  const current = await readKillSwitchState();
  // Also refuse transitions OUT OF medium/hard via UI — once elevated
  // above soft, only the CLI can bring it back down. This prevents
  // the UI being used to silently lower the gate.
  if (current.tier === 'medium' || current.tier === 'hard') {
    throw new Error('Kill-switch is above soft; use CLI to transition out of medium/hard per dec-kill-switch-design-first');
  }
  const now = new Date().toISOString();
  const newState = {
    tier: params.to,
    since: now,
    reason: params.reason ?? null,
    autonomyDial: params.to === 'off' ? 1 : 0.5,
  };
  const fsWriteModule = await import('node:fs/promises');
  const dir = join(LAG_DIR, 'kill-switch');
  await fsWriteModule.mkdir(dir, { recursive: true });
  await fsWriteModule.writeFile(
    join(dir, 'state.json'),
    JSON.stringify({ ...newState, transitioned_by: params.actor_id }, null, 2),
    'utf8',
  );
  return newState;
}

async function handleAtomPropose(params: {
  content: string;
  type: string;
  confidence: number;
  proposer_id: string;
  scope?: string;
}): Promise<{ id: string; path: string }> {
  const ts = new Date();
  const stamp = ts.toISOString().replace(/[:.]/g, '').replace('T', '').slice(0, 14);
  const slug = params.content.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'atom';
  /*
   * Append a random nonce so two proposals with the same slug+second
   * don't collide. Before this, a second click within the same
   * second produced an identical id + default writeFile (which
   * overwrites), so the first proposal was silently lost. Using
   * `crypto.randomBytes` for entropy and writing with `flag: 'wx'`
   * means the write fails loudly on EEXIST instead of clobbering.
   */
  const { randomBytes } = await import('node:crypto');
  const nonce = randomBytes(3).toString('hex'); // 6 hex chars
  const id = atomFilenameFromId(`prop-${slug}-${stamp}-${nonce}`).replace(/\.json$/, '');
  const filename = `${id}.json`;
  const atom: Atom & { scope: string; validation_status: string; last_reinforced_at: string } = {
    id,
    type: params.type,
    layer: 'L0',
    content: params.content,
    principal_id: params.proposer_id,
    confidence: Math.max(0, Math.min(1, params.confidence)),
    created_at: ts.toISOString(),
    last_reinforced_at: ts.toISOString(),
    scope: params.scope ?? 'project',
    validation_status: 'pending_review',
    provenance: {
      kind: 'console-proposal',
      source: { tool: 'lag-console', agent_id: params.proposer_id },
      derived_from: [],
    },
    supersedes: [],
    superseded_by: [],
  };
  const fsWriteModule = await import('node:fs/promises');
  await fsWriteModule.writeFile(
    join(ATOMS_DIR, filename),
    JSON.stringify(atom, null, 2),
    { encoding: 'utf8', flag: 'wx' },
  );
  // The file-watcher will pick up the new file and update the index
  // + broadcast atom.created on its own cycle.
  return { id, path: filename };
}

async function handleArbitrationCompare(aId: string, bId: string): Promise<{
  a: { atom: Atom | null; rank: number; breakdown: Record<string, number> };
  b: { atom: Atom | null; rank: number; breakdown: Record<string, number> };
  winner: 'a' | 'b' | 'tie';
}> {
  const all = await readAllAtoms();
  const byId = new Map(all.map((a) => [a.id, a]));
  const aAtom = byId.get(aId) ?? null;
  const bAtom = byId.get(bId) ?? null;
  const score = (atom: Atom | null) => {
    if (!atom) return { total: 0, breakdown: { layer: 0, provenance: 0, hierarchy: 0, confidence: 0 } };
    const layerMap: Record<string, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };
    const layerPts = (layerMap[atom.layer] ?? 0) * 10000;
    const provKind = (atom.provenance as { kind?: string } | undefined)?.kind ?? 'unknown';
    const provMap: Record<string, number> = {
      'operator-seeded': 90,
      'user-directive': 80,
      'bootstrap': 70,
      'agent-observed': 40,
      'unknown': 10,
    };
    const provenancePts = (provMap[provKind] ?? 10) * 100;
    const hierarchyPts = 50; // stubbed until principal depth is wired
    const confidencePts = Math.floor((atom.confidence ?? 0) * 10);
    return {
      total: layerPts + provenancePts + hierarchyPts + confidencePts,
      breakdown: { layer: layerPts, provenance: provenancePts, hierarchy: hierarchyPts, confidence: confidencePts },
    };
  };
  const a = score(aAtom);
  const b = score(bAtom);
  const winner: 'a' | 'b' | 'tie' = a.total > b.total ? 'a' : b.total > a.total ? 'b' : 'tie';
  return {
    a: { atom: aAtom, rank: a.total, breakdown: a.breakdown },
    b: { atom: bAtom, rank: b.total, breakdown: b.breakdown },
    winner,
  };
}

async function readKillSwitchState(): Promise<{
  tier: 'off' | 'soft' | 'medium' | 'hard';
  since: string | null;
  reason: string | null;
  autonomyDial: number;
}> {
  try {
    const raw = await readFile(join(LAG_DIR, 'kill-switch', 'state.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      tier?: 'off' | 'soft' | 'medium' | 'hard';
      since?: string | null;
      reason?: string | null;
      autonomyDial?: number;
    };
    return {
      tier: parsed.tier ?? 'off',
      since: parsed.since ?? null,
      reason: parsed.reason ?? null,
      autonomyDial: typeof parsed.autonomyDial === 'number' ? parsed.autonomyDial : 1,
    };
  } catch {
    // Absent state file = fully autonomous, no tier active.
    return { tier: 'off', since: null, reason: null, autonomyDial: 1 };
  }
}

async function handleDaemonStatus(): Promise<{
  atomCount: number;
  lastAtomId: string | null;
  lastAtomCreatedAt: string | null;
  secondsSinceLastAtom: number | null;
  atomsInLastHour: number;
  atomsInLastDay: number;
  lagDir: string;
}> {
  const all = await readAllAtoms();
  let latest: Atom | null = null;
  for (const a of all) {
    if (!a.created_at) continue;
    if (!latest || a.created_at > latest.created_at) latest = a;
  }
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const dayAgo = now - 24 * 60 * 60 * 1000;
  let inHour = 0;
  let inDay = 0;
  for (const a of all) {
    const t = a.created_at ? Date.parse(a.created_at) : NaN;
    if (Number.isFinite(t)) {
      if (t >= hourAgo) inHour++;
      if (t >= dayAgo) inDay++;
    }
  }
  const lastTs = latest?.created_at ? Date.parse(latest.created_at) : NaN;
  const secondsSince = Number.isFinite(lastTs) ? Math.max(0, Math.round((now - lastTs) / 1000)) : null;
  return {
    atomCount: all.length,
    lastAtomId: latest?.id ?? null,
    lastAtomCreatedAt: latest?.created_at ?? null,
    secondsSinceLastAtom: secondsSince,
    atomsInLastHour: inHour,
    atomsInLastDay: inDay,
    lagDir: LAG_DIR,
  };
}

async function handlePlansList(): Promise<Atom[]> {
  const all = await readAllAtoms();
  const out = all.filter((a) => {
    if (a.superseded_by && a.superseded_by.length > 0) return false;
    if (a.type === 'plan') return true;
    const atomAny = a as unknown as Record<string, unknown>;
    if (atomAny['plan_state'] !== undefined) return true;
    return false;
  });
  out.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  return out;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;

  // CORS preflight — only answer with CORS headers for allowlisted
  // origins. A request from a non-allowlisted origin still gets 204
  // (so non-CORS clients aren't broken) but without the
  // Access-Control-Allow-Origin header, so the browser refuses the
  // subsequent request.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeadersFor(req));
    res.end();
    return;
  }

  /*
   * Defense-in-depth: reject state-changing requests whose Origin
   * header is present and not allowlisted. CORS is advisory — the
   * browser can be bypassed (old browsers, native clients, headers
   * forged by a proxy). The server must also enforce that a mutation
   * coming from a foreign origin doesn't go through, because the
   * mutations here write governance atoms to disk.
   *
   * GET stays open so a same-origin-misconfigured client can still
   * read; only the mutation surface is gated.
   */
  if (req.method !== 'GET' && req.method !== 'HEAD' && !isAllowedOrigin(origin)) {
    sendErr(req, res, 403, 'origin-not-allowed', `Origin ${origin} is not allowlisted for state-changing requests`);
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const path = url.pathname;

  if (path === '/api/health') {
    sendOk(req, res, { ok: true, lagDir: LAG_DIR, atomsDir: ATOMS_DIR });
    return;
  }

  if (path === '/api/session.current' && req.method === 'POST') {
    /*
     * Returns the actor id the server is configured to attribute UI
     * writes to. Read from `LAG_CONSOLE_ACTOR_ID` env var. If unset,
     * data.actor_id is null and the UI fails closed on mutations —
     * per canon `dev-framework-mechanism-only`, the console must NOT
     * ship hardcoded instance identities. Each deployment configures
     * this explicitly at boot.
     */
    const actorId = process.env['LAG_CONSOLE_ACTOR_ID'] ?? null;
    sendOk(req, res, { actor_id: actorId });
    return;
  }

  if (path === '/api/canon.list' && req.method === 'POST') {
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const bodyTypes = body['types'];
    const bodySearch = body['search'];
    const types = Array.isArray(bodyTypes) ? (bodyTypes as string[]) : undefined;
    const search = typeof bodySearch === 'string' ? bodySearch : undefined;
    const params: { types?: string[]; search?: string } = {
      ...(types !== undefined ? { types } : {}),
      ...(search !== undefined ? { search } : {}),
    };
    try {
      const data = await handleCanonList(params);
      sendOk(req, res, data);
    } catch (err) {
      sendErr(req, res, 500, 'canon-list-failed', (err as Error).message);
    }
    return;
  }

  if (path === '/api/canon.stats' && req.method === 'POST') {
    try {
      const data = await handleCanonStats();
      sendOk(req, res, data);
    } catch (err) {
      sendErr(req, res, 500, 'canon-stats-failed', (err as Error).message);
    }
    return;
  }

  if (path === '/api/principals.list' && req.method === 'POST') {
    try {
      const data = await handlePrincipalsList();
      sendOk(req, res, data);
    } catch (err) {
      sendErr(req, res, 500, 'principals-list-failed', (err as Error).message);
    }
    return;
  }

  if (path === '/api/activities.list' && req.method === 'POST') {
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const bodyLimit = body['limit'];
    const bodyTypes = body['types'];
    const limit = typeof bodyLimit === 'number' ? bodyLimit : undefined;
    const types = Array.isArray(bodyTypes) ? (bodyTypes as string[]) : undefined;
    const params: { limit?: number; types?: string[] } = {
      ...(limit !== undefined ? { limit } : {}),
      ...(types !== undefined ? { types } : {}),
    };
    try {
      const data = await handleActivitiesList(params);
      sendOk(req, res, data);
    } catch (err) {
      sendErr(req, res, 500, 'activities-list-failed', (err as Error).message);
    }
    return;
  }

  if (path === '/api/canon.applicable' && req.method === 'POST') {
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const principal_id = typeof body['principal_id'] === 'string' ? (body['principal_id'] as string) : '';
    const layer = (typeof body['layer'] === 'string' ? body['layer'] : 'L3') as 'L0' | 'L1' | 'L2' | 'L3';
    const scope = typeof body['scope'] === 'string' ? (body['scope'] as string) : undefined;
    const atomTypes = Array.isArray(body['atomTypes']) ? (body['atomTypes'] as string[]) : undefined;
    if (!principal_id) {
      sendErr(req, res, 400, 'missing-principal', 'canon.applicable requires { principal_id }');
      return;
    }
    if (!['L0', 'L1', 'L2', 'L3'].includes(layer)) {
      sendErr(req, res, 400, 'invalid-layer', 'layer must be L0|L1|L2|L3');
      return;
    }
    try {
      const data = await handleCanonApplicable({
        principal_id,
        layer,
        ...(scope !== undefined ? { scope } : {}),
        ...(atomTypes !== undefined ? { atomTypes } : {}),
      });
      sendOk(req, res, data);
    } catch (err) {
      sendErr(req, res, 500, 'canon-applicable-failed', (err as Error).message);
    }
    return;
  }

  if (path === '/api/atoms.reinforce' && req.method === 'POST') {
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const id = typeof body['id'] === 'string' ? (body['id'] as string) : '';
    const actor_id = typeof body['actor_id'] === 'string' ? (body['actor_id'] as string) : '';
    if (!id || !actor_id) {
      sendErr(req, res, 400, 'missing-params', 'atoms.reinforce requires { id, actor_id }');
      return;
    }
    try {
      const data = await handleAtomReinforce({ id, actor_id });
      sendOk(req, res, data);
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === 'invalid-atom-id') {
        sendErr(req, res, 400, 'invalid-atom-id', e.message);
      } else {
        sendErr(req, res, 500, 'atom-reinforce-failed', e.message);
      }
    }
    return;
  }

  if (path === '/api/atoms.mark-stale' && req.method === 'POST') {
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const id = typeof body['id'] === 'string' ? (body['id'] as string) : '';
    const actor_id = typeof body['actor_id'] === 'string' ? (body['actor_id'] as string) : '';
    const reason = typeof body['reason'] === 'string' ? (body['reason'] as string) : undefined;
    if (!id || !actor_id) {
      sendErr(req, res, 400, 'missing-params', 'atoms.mark-stale requires { id, actor_id }');
      return;
    }
    try {
      const data = await handleAtomMarkStale({ id, actor_id, ...(reason !== undefined ? { reason } : {}) });
      sendOk(req, res, data);
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === 'invalid-atom-id') {
        sendErr(req, res, 400, 'invalid-atom-id', e.message);
      } else {
        sendErr(req, res, 500, 'atom-mark-stale-failed', e.message);
      }
    }
    return;
  }

  if (path === '/api/kill-switch.transition' && req.method === 'POST') {
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const to = typeof body['to'] === 'string' ? (body['to'] as string) : '';
    const actor_id = typeof body['actor_id'] === 'string' ? (body['actor_id'] as string) : '';
    const reason = typeof body['reason'] === 'string' ? (body['reason'] as string) : undefined;
    if (to !== 'off' && to !== 'soft') {
      sendErr(req, res, 403, 'tier-not-ui-transitionable', 'UI may only transition kill-switch to off|soft');
      return;
    }
    if (!actor_id) {
      sendErr(req, res, 400, 'missing-actor', 'kill-switch.transition requires { actor_id }');
      return;
    }
    try {
      const data = await handleKillSwitchTransition({ to: to as 'off' | 'soft', actor_id, ...(reason !== undefined ? { reason } : {}) });
      sendOk(req, res, data);
    } catch (err) {
      sendErr(req, res, 403, 'kill-switch-transition-refused', (err as Error).message);
    }
    return;
  }

  if (path === '/api/atoms.propose' && req.method === 'POST') {
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const content = typeof body['content'] === 'string' ? (body['content'] as string).trim() : '';
    const type = typeof body['type'] === 'string' ? (body['type'] as string) : '';
    const confidence = typeof body['confidence'] === 'number' ? (body['confidence'] as number) : 0.5;
    const proposer_id = typeof body['proposer_id'] === 'string' ? (body['proposer_id'] as string) : '';
    const scope = typeof body['scope'] === 'string' ? (body['scope'] as string) : undefined;
    if (!content || content.length < 16) {
      sendErr(req, res, 400, 'content-too-short', 'content must be at least 16 characters');
      return;
    }
    if (!['directive', 'decision', 'preference', 'reference'].includes(type)) {
      sendErr(req, res, 400, 'invalid-type', 'type must be directive|decision|preference|reference');
      return;
    }
    if (!proposer_id) {
      sendErr(req, res, 400, 'missing-proposer', 'proposer_id is required');
      return;
    }
    try {
      const data = await handleAtomPropose({
        content,
        type,
        confidence,
        proposer_id,
        ...(scope !== undefined ? { scope } : {}),
      });
      sendOk(req, res, data);
    } catch (err) {
      sendErr(req, res, 500, 'atom-propose-failed', (err as Error).message);
    }
    return;
  }

  if (path === '/api/atoms.chain' && req.method === 'POST') {
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const id = typeof body['id'] === 'string' ? (body['id'] as string) : '';
    const depth = typeof body['depth'] === 'number' ? (body['depth'] as number) : 5;
    if (!id) { sendErr(req, res, 400, 'missing-id', 'atoms.chain requires { id: string }'); return; }
    try {
      const data = await handleAtomChain(id, depth);
      sendOk(req, res, data);
    } catch (err) {
      sendErr(req, res, 500, 'atoms-chain-failed', (err as Error).message);
    }
    return;
  }

  if (path === '/api/atoms.cascade' && req.method === 'POST') {
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const id = typeof body['id'] === 'string' ? (body['id'] as string) : '';
    const depth = typeof body['depth'] === 'number' ? (body['depth'] as number) : 5;
    if (!id) { sendErr(req, res, 400, 'missing-id', 'atoms.cascade requires { id: string }'); return; }
    try {
      const data = await handleAtomCascade(id, depth);
      sendOk(req, res, data);
    } catch (err) {
      sendErr(req, res, 500, 'atoms-cascade-failed', (err as Error).message);
    }
    return;
  }

  if (path === '/api/arbitration.compare' && req.method === 'POST') {
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const a = typeof body['a'] === 'string' ? (body['a'] as string) : '';
    const b = typeof body['b'] === 'string' ? (body['b'] as string) : '';
    if (!a || !b) { sendErr(req, res, 400, 'missing-ids', 'arbitration.compare requires { a, b }'); return; }
    try {
      const data = await handleArbitrationCompare(a, b);
      sendOk(req, res, data);
    } catch (err) {
      sendErr(req, res, 500, 'arbitration-compare-failed', (err as Error).message);
    }
    return;
  }

  if (path === '/api/atoms.references' && req.method === 'POST') {
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const id = typeof body['id'] === 'string' ? (body['id'] as string) : '';
    if (!id) {
      sendErr(req, res, 400, 'missing-id', 'atoms.references requires { id: string }');
      return;
    }
    try {
      const data = await handleAtomReferences(id);
      sendOk(req, res, data);
    } catch (err) {
      sendErr(req, res, 500, 'atoms-references-failed', (err as Error).message);
    }
    return;
  }

  if (path === '/api/canon.drift' && req.method === 'POST') {
    try {
      const data = await handleDriftReport();
      sendOk(req, res, data);
    } catch (err) {
      sendErr(req, res, 500, 'canon-drift-failed', (err as Error).message);
    }
    return;
  }

  if (path === '/api/kill-switch.state' && req.method === 'POST') {
    /*
     * Kill-switch tier + autonomy dial. Reads .lag/kill-switch/state.json
     * if present; defaults to `off` + autonomy 1.0 when the file is
     * missing. Stays trivial here so the UI doesn't need to branch
     * on absence — the file is the source of truth.
     */
    try {
      const state = await readKillSwitchState();
      sendOk(req, res, state);
    } catch (err) {
      sendErr(req, res, 500, 'kill-switch-state-failed', (err as Error).message);
    }
    return;
  }

  if (path === '/api/daemon.status' && req.method === 'POST') {
    try {
      const data = await handleDaemonStatus();
      sendOk(req, res, data);
    } catch (err) {
      sendErr(req, res, 500, 'daemon-status-failed', (err as Error).message);
    }
    return;
  }

  if (path === '/api/plans.list' && req.method === 'POST') {
    try {
      const data = await handlePlansList();
      sendOk(req, res, data);
    } catch (err) {
      sendErr(req, res, 500, 'plans-list-failed', (err as Error).message);
    }
    return;
  }

  /*
   * SSE live-tail: clients subscribing to /api/events/atoms get an
   * "atom.created" push whenever a new .json file lands in
   * .lag/atoms. The file-watcher is started ONCE per server and
   * multiplexed across subscribers, so 100 open tabs == 1 watcher.
   */
  if (path.startsWith('/api/events/') && req.method === 'GET') {
    const channel = path.substring('/api/events/'.length);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`event: open\ndata: ${JSON.stringify({ channel, at: new Date().toISOString() })}\n\n`);
    if (channel === 'atoms') {
      atomSubscribers.add(res);
    }
    const pingInterval = setInterval(() => {
      res.write(`event: ping\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
    }, 30_000);
    req.on('close', () => {
      clearInterval(pingInterval);
      atomSubscribers.delete(res);
    });
    return;
  }

  sendErr(req, res, 404, 'not-found', `no handler for ${req.method} ${path}`);
}

// ---------------------------------------------------------------------------
// Server start.
// ---------------------------------------------------------------------------

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('[backend] unhandled:', err);
    if (!res.headersSent) sendErr(req, res, 500, 'internal', (err as Error).message);
  });
});

const atomSubscribers = new Set<ServerResponse>();

function broadcastAtomEvent(event: string, payload: unknown): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const sub of atomSubscribers) {
    try { sub.write(msg); } catch { atomSubscribers.delete(sub); }
  }
}

/*
 * File watcher: maintains the in-memory atom index and broadcasts
 * SSE events to subscribers. `rename` events fire on create AND
 * delete; we disambiguate by checking whether the file exists now
 * via an actual filesystem read (via refreshAtomInIndex, which
 * drops on read failure). The watcher keeps memory bounded —
 * deletions prune the index entry, fixing the previous leak where
 * `knownAtomFiles` grew without a matching prune.
 */
async function startAtomWatcher(): Promise<void> {
  await primeAtomIndex();
  try {
    fsWatch(ATOMS_DIR, { persistent: false }, async (eventType, filename) => {
      if (!filename || !filename.endsWith('.json')) return;
      const id = filename.replace(/\.json$/, '');
      if (eventType === 'rename') {
        // Could be create OR delete. Attempt a fresh read — if it
        // succeeds the file exists (classify as create/refresh);
        // if it fails, drop from index (classify as delete).
        const hadIt = atomIndex.has(filename);
        await refreshAtomInIndex(filename);
        const hasItNow = atomIndex.has(filename);
        if (!hadIt && hasItNow) {
          broadcastAtomEvent('atom.created', { id, at: new Date().toISOString() });
        } else if (hadIt && !hasItNow) {
          broadcastAtomEvent('atom.deleted', { id, at: new Date().toISOString() });
        } else if (hasItNow) {
          broadcastAtomEvent('atom.changed', { id, at: new Date().toISOString() });
        }
      } else if (eventType === 'change') {
        await refreshAtomInIndex(filename);
        broadcastAtomEvent('atom.changed', { id, at: new Date().toISOString() });
      }
    });
    console.log(`[backend] watching ${ATOMS_DIR} for atom changes`);
  } catch (err) {
    console.warn(`[backend] file-watch unavailable: ${(err as Error).message}`);
  }
}

server.listen(PORT, () => {
  console.log(`[backend] LAG Console backend listening on http://localhost:${PORT}`);
  console.log(`[backend] reading atoms from ${ATOMS_DIR}`);
  void startAtomWatcher();
});

// Clean shutdown for dev watch reloads.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`[backend] received ${sig}; closing`);
    server.close(() => process.exit(0));
  });
}
