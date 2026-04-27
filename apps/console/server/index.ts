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
  isConsoleWritesAllowed,
  makeAllowedOriginSet,
} from './security';
import { parseAutonomyDial } from './kill-switch-state';
import { median, extractFailureStage } from './metrics-rollup';
import {
  countActivePolicies,
  pickActiveElevations,
  pickLastCanonApply,
  pickOperatorPrincipalId,
  pickRecentEscalations,
  pickRecentKillSwitchTransitions,
  pickRecentOperatorActions,
  readSentinelState,
  resolveSentinelInside,
  tierFromKillSwitch,
  type ControlStatus,
} from './control-status';
import {
  buildActorActivityResponse,
  type ActorActivityAtom,
  type ActorActivityResponse,
} from './actor-activity';
import {
  buildPrincipalTree,
  type PrincipalTreeResult,
} from './principal-tree';
import {
  buildPrincipalStatsResponse,
  type PrincipalStatsAtom,
  type PrincipalStatsResponse,
} from './principal-stats';
import {
  computeHeartbeat as computeLiveOpsHeartbeat,
  listActiveSessions as listLiveOpsActiveSessions,
  listLiveDeliberations as listLiveOpsDeliberations,
  listInFlightExecutions as listLiveOpsInFlightExecutions,
  listRecentTransitions as listLiveOpsRecentTransitions,
  computeDaemonPosture as computeLiveOpsDaemonPosture,
  listPrActivity as listLiveOpsPrActivity,
} from './live-ops';
import type { LiveOpsAtom, LiveOpsSnapshot } from './live-ops-types';

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

/*
 * Console v1 is read-only by contract (apps/console/CLAUDE.md "Scope
 * boundaries"). The `/api/atoms.propose` route is an explicit dev-only
 * escape hatch: it lets a developer feed the propose-atom UX without
 * dropping to the CLI, but the v1 invariant requires writes to flow
 * through `node scripts/decide.mjs` (or equivalent) by default.
 *
 * Gating: the route is disabled unless `LAG_CONSOLE_ALLOW_WRITES=1` is
 * set in the server environment. When unset, the handler returns 403
 * with `code: 'console-read-only'` so a misconfigured client surfaces
 * a loud error pointing at the CLI alternative rather than silently
 * minting an L0 atom.
 *
 * Why an env-gate (not removal): the propose UI ships a real path
 * (L0 + `validation_status: pending_review`, `prop-` id prefix, the
 * file-watcher picks it up) and removing it would drop an in-flight
 * developer affordance. Env-gating keeps the contract airtight (an
 * out-of-the-box install is read-only) while preserving the workflow
 * for developers who explicitly opt in.
 *
 * This gate does NOT replace the existing origin-allowlist + CSRF
 * defense; the origin check still runs on every state-changing
 * request before the route handler is reached.
 *
 * The kill-switch transition route stays gated by tier (off|soft only)
 * rather than this flag, because it is canon-required (the soft-tier
 * `STOP` sentinel is part of the kill-switch design and the operator
 * needs a one-click halt from the dashboard regardless of dev mode).
 */
const ALLOW_CONSOLE_WRITES = isConsoleWritesAllowed(process.env['LAG_CONSOLE_ALLOW_WRITES']);

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
 * Per-principal atom counts by type. A projection over the live atom
 * snapshot per canon `arch-atomstore-source-of-truth`; consumers
 * (PrincipalCard chip row) get a quick "X plans, Y observations,
 * Z decisions" without re-fetching the full atom feed and re-counting
 * client-side.
 */
async function handlePrincipalsStats(): Promise<PrincipalStatsResponse> {
  const all = await readAllAtoms();
  // Atom -> PrincipalStatsAtom is a structural narrowing.
  const projected = all as ReadonlyArray<PrincipalStatsAtom>;
  return buildPrincipalStatsResponse(projected, new Date());
}

/*
 * Read the optional skill markdown for a principal. Skill docs live
 * at .claude/skills/<principal_id>/SKILL.md; not every principal has
 * one (e.g. apex-agent does not). Returns { content: null } when the
 * file is absent, distinct from a 500 on read error so the client can
 * cleanly fall through to "no soul content yet".
 *
 * Path-traversal defense: principal_id is constrained to the same
 * shape the principal-id slot uses elsewhere ([a-z0-9_-]+). A
 * non-conforming id yields a 400 (rather than a silent skip) so a
 * caller bug surfaces at the boundary rather than masking as
 * "no skill".
 */
const PRINCIPAL_ID_RE = /^[a-z0-9_-]+$/;
const SKILLS_DIR = resolve(REPO_ROOT, '.claude', 'skills');

async function handlePrincipalSkill(params: {
  principal_id: string;
}): Promise<{ content: string | null }> {
  const id = String(params.principal_id ?? '').trim();
  if (!PRINCIPAL_ID_RE.test(id)) {
    throw new Error(`invalid principal_id: ${JSON.stringify(params.principal_id)}`);
  }
  const path = join(SKILLS_DIR, id, 'SKILL.md');
  try {
    const content = await readFile(path, 'utf8');
    return { content };
  } catch (err) {
    /*
     * ENOENT is the expected "no skill yet" case. Any other code is
     * a real read error worth surfacing; rethrow so the route handler
     * returns 500 with the message, rather than masking as null.
     */
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { content: null };
    }
    throw err;
  }
}

/*
 * Principal hierarchy tree handler. The pure builder lives in
 * ./principal-tree.ts so it can be unit-tested without standing up
 * the HTTP server. This handler just hydrates the input from the
 * filesystem and delegates.
 */
async function handlePrincipalsTree(): Promise<PrincipalTreeResult> {
  const principals = await readAllPrincipals();
  return buildPrincipalTree(principals);
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
  // Cap raised 500 → 20000 per plan-raise-activities-list-cap-from-500-to-20000-cto-actor-20260426104923; revisit when sustained 7-day avg atoms/day > 238 (heatmap-cells aggregation pivot).
  const limit = Math.max(1, Math.min(20000, params.limit ?? 100));
  return out.slice(0, limit);
}

/*
 * Actor-activity stream: a "control tower" view of which principals are
 * currently writing atoms. Reads the live atom set, then delegates to
 * the pure transform in actor-activity.ts (which is unit-tested
 * independent of HTTP plumbing).
 *
 * Read-only by design: the handler never writes to the atom store nor
 * mutates any in-memory cache state. The atom index is consulted via
 * readAllAtoms() (a snapshot, not the live Map) and the resulting
 * response is a derived projection.
 */
async function handleActorActivityStream(params: {
  limit?: number;
  principal_id?: string;
  exclude_types?: ReadonlyArray<string>;
}): Promise<ActorActivityResponse> {
  const all = await readAllAtoms();
  // Atom -> ActorActivityAtom is a structural narrowing. The runtime
  // shape is identical; the cast carries no risk because the consumer
  // only reads the listed fields.
  const projected = all as ReadonlyArray<ActorActivityAtom>;
  return buildActorActivityResponse(projected, params, new Date());
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
  transitioned_by: string | null;
}> {
  try {
    const raw = await readFile(join(LAG_DIR, 'kill-switch', 'state.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      tier?: 'off' | 'soft' | 'medium' | 'hard';
      since?: string | null;
      reason?: string | null;
      autonomyDial?: number;
      transitioned_by?: string | null;
    };
    /*
     * Three-way fallback for autonomyDial, per the kill-switch safety
     * contract:
     *   - valid number in [0..1] → pass through (clamped by helper).
     *   - malformed payload (NaN, Infinity, non-number) from a
     *     present state file → fail CLOSED to 0 (fully gated).
     *     A torn state file must not silently escalate runtime
     *     posture to "fully autonomous".
     *   - absent state file → caught by the outer try/catch below,
     *     falls back to 1 (no tier active).
     */
    const sanitized = parseAutonomyDial(parsed.autonomyDial);
    return {
      tier: parsed.tier ?? 'off',
      since: parsed.since ?? null,
      reason: parsed.reason ?? null,
      autonomyDial: sanitized === null ? 0 : sanitized,
      transitioned_by: parsed.transitioned_by ?? null,
    };
  } catch {
    // Absent state file = fully autonomous, no tier active.
    return { tier: 'off', since: null, reason: null, autonomyDial: 1, transitioned_by: null };
  }
}

/*
 * Operator control-panel status. Projection over the live filesystem
 * + atom store. Read-only by contract: this handler MUST NOT write
 * the STOP sentinel from the console UI -- engaging the kill switch
 * crosses the operator-shell trust boundary, and the UI surfaces the
 * manual `touch .lag/STOP` command instead. Removing that read-only
 * guarantee changes the threat model and is out of scope for v1.
 *
 * Path-traversal: the sentinel path is resolved via
 * `resolveSentinelInside(LAG_DIR)` which rejects any target whose
 * resolved location escapes the .lag directory. fs.stat (not access)
 * gives us the mtime, surfaced as `engaged_at`, so the operator can
 * see when the halt landed.
 *
 * Stale-data: callers (the React view) refetch on a 3-second interval
 * via TanStack Query refetchInterval. For a single operator on the
 * dashboard this is fine; if scaling matters (many concurrent
 * operators on the same backend), a rate-limit middleware on this
 * handler is the natural follow-up but not load-bearing for v1.
 */
async function handleControlStatus(): Promise<ControlStatus> {
  const sentinelAbs = resolveSentinelInside(LAG_DIR, 'STOP');
  const [killSwitchState, kill_switch, atoms, principals] = await Promise.all([
    readKillSwitchState(),
    readSentinelState(sentinelAbs),
    readAllAtoms(),
    readAllPrincipals(),
  ]);
  const autonomy_tier = tierFromKillSwitch(killSwitchState.tier);
  /*
   * Actors are principals whose role is not 'apex'. The apex root is
   * the operator; everything signed_by it is a governed actor. This
   * matches how the principal hierarchy actually composes in the org.
   */
  const actors_governed = principals.filter((p) => p.role !== 'apex' && p.active !== false).length;
  /*
   * The four richer lists are pure projections over the atom set
   * (per the v1 read-only contract; no new auth surfaces). The
   * helpers themselves enforce safe-field shaping (operator-action
   * atoms drop full args/content) and per-list caps (MAX_LIST_ITEMS
   * keeps any one list from dominating the payload).
   */
  const recent_kill_switch_transitions = pickRecentKillSwitchTransitions(killSwitchState, atoms);
  const active_elevations = pickActiveElevations(atoms, Date.now());
  const recent_operator_actions = pickRecentOperatorActions(atoms);
  const recent_escalations = pickRecentEscalations(atoms);
  return {
    kill_switch,
    autonomy_tier,
    actors_governed,
    policies_active: countActivePolicies(atoms),
    last_canon_apply: pickLastCanonApply(atoms),
    operator_principal_id: pickOperatorPrincipalId(principals),
    recent_kill_switch_transitions,
    active_elevations,
    recent_operator_actions,
    recent_escalations,
  };
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

/*
 * Canon suggestions: agent-observed L1 atoms whose metadata.kind is
 * `canon-proposal-suggestion`. The console READS these so the operator
 * can scan pending suggestions; the console NEVER writes them. Triage
 * (promote/dismiss/defer) goes through scripts/canon-suggest-triage.mjs
 * + scripts/decide.mjs per inv-l3-requires-human + the apps/console
 * "v1 read-only" scope boundary.
 *
 * The discriminator is the `metadata.kind` string, NOT a new AtomType.
 * Per dev-substrate-not-prescription, the framework's AtomType union
 * stays untouched; suggestions are a metadata-shaped projection over
 * the existing observation atom type.
 */
const CANON_SUGGESTION_KIND = 'canon-proposal-suggestion';
const CANON_SUGGESTION_REVIEW_STATES = ['pending', 'promoted', 'dismissed', 'deferred'] as const;
type CanonSuggestionReviewState = typeof CANON_SUGGESTION_REVIEW_STATES[number];

async function handleCanonSuggestionsList(params: {
  review_state?: CanonSuggestionReviewState;
}): Promise<Atom[]> {
  const all = await readAllAtoms();
  const wanted = params.review_state ?? 'pending';
  const out = all.filter((a) => {
    if (a.type !== 'observation') return false;
    // Defense-in-depth: same taint + supersession guards `filterCanon`
    // (line 171), `handleCanonApplicable` (line 505), and
    // `handleDriftReport` (line 442) apply to every other read
    // projection. A tainted suggestion (scout principal compromised
    // post-write) MUST NOT surface in the operator's triage inbox; the
    // operator's mental model is "these are clean candidates for
    // promotion", and decide.mjs is the downstream gate, not the only
    // one. Pinning to L1 is bonus rigor: `buildSuggestionAtom` always
    // writes L1, and this read can't accidentally pick up an L3 atom
    // that drifted to share the metadata.kind discriminator.
    if (a.taint && a.taint !== 'clean') return false;
    if (a.layer !== 'L1') return false;
    if (a.superseded_by && a.superseded_by.length > 0) return false;
    const meta = a.metadata as Record<string, unknown> | undefined;
    if (!meta || meta['kind'] !== CANON_SUGGESTION_KIND) return false;
    return meta['review_state'] === wanted;
  });
  // Newest first so the freshly-suggested ones land at the top of the
  // operator's review panel.
  out.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  return out;
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

// ---------------------------------------------------------------------------
// Metrics rollup: dashboard digest of autonomous-loop health.
//
// Single pass over the atom store derives: total atoms, atoms in window,
// plan counts by state, autonomous-loop dispatched/succeeded/failed in
// window, median drafter cost (from code-author-invoked observation atoms),
// median dispatch-to-merge minutes (correlate plan invocation -> plan-merge-
// settled), median CR rounds per PR (heuristic: count distinct
// pr-observation atoms per plan).
//
// This handler is the conference-demo dashboard panel. Read-only;
// derives everything from the existing AtomStore projection.
// ---------------------------------------------------------------------------

interface MetricsRollupFailure {
  readonly plan_id: string;
  readonly stage: string;
  readonly message_preview: string;
  readonly at: string;
}

interface MetricsRollup {
  readonly window_hours: number;
  readonly atoms_total: number;
  readonly atoms_in_window: number;
  readonly plans: {
    readonly total: number;
    readonly by_state: Readonly<Record<string, number>>;
    readonly success_rate: number;
  };
  readonly autonomous_loop: {
    readonly dispatched_in_window: number;
    readonly succeeded_in_window: number;
    readonly failed_in_window: number;
    readonly median_drafter_cost_usd: number | null;
    readonly median_dispatch_to_merge_minutes: number | null;
    readonly median_cr_rounds_per_pr: number | null;
  };
  readonly recent_failures: ReadonlyArray<MetricsRollupFailure>;
}

async function handleMetricsRollup(params: { window_hours?: number }): Promise<MetricsRollup> {
  const windowHours = Math.max(1, Math.min(24 * 30, params.window_hours ?? 24));
  const all = await readAllAtoms();
  const now = Date.now();
  const windowStart = now - windowHours * 60 * 60 * 1000;

  // Atom totals.
  const atomsInWindow = all.filter((a) => {
    const t = a.created_at ? Date.parse(a.created_at) : NaN;
    return Number.isFinite(t) && t >= windowStart;
  }).length;

  // Plans (every plan atom OR atom carrying top-level plan_state).
  const plans = all.filter((a) => {
    if (a.superseded_by && a.superseded_by.length > 0) return false;
    if (a.type === 'plan') return true;
    const atomAny = a as unknown as Record<string, unknown>;
    return atomAny['plan_state'] !== undefined;
  });

  const byState: Record<string, number> = {};
  for (const p of plans) {
    const state = (p as unknown as { plan_state?: string }).plan_state ?? 'unknown';
    byState[state] = (byState[state] ?? 0) + 1;
  }
  const succeededCount = byState['succeeded'] ?? 0;
  const failedCount = byState['failed'] ?? 0;
  const successRate = succeededCount + failedCount > 0
    ? succeededCount / (succeededCount + failedCount)
    : 0;

  // Autonomous-loop activity in window. Use code-author-invoked
  // observation atoms (or any *-invoked) as the dispatch signal:
  // their created_at is the dispatch timestamp and they carry
  // executor_result.total_cost_usd for the drafter cost median.
  const invokedInWindow: Atom[] = [];
  const invokedAll: Atom[] = [];
  for (const a of all) {
    if (a.type !== 'observation') continue;
    const m = (a.metadata ?? {}) as Record<string, unknown>;
    const kind = String(m['kind'] ?? '');
    if (kind !== 'code-author-invoked' && !kind.endsWith('-invoked')) continue;
    invokedAll.push(a);
    const t = a.created_at ? Date.parse(a.created_at) : NaN;
    if (Number.isFinite(t) && t >= windowStart) invokedInWindow.push(a);
  }

  // Median drafter cost across in-window invocations (USD).
  const costs: number[] = [];
  for (const a of invokedInWindow) {
    const m = (a.metadata ?? {}) as Record<string, unknown>;
    const er = m['executor_result'] as Record<string, unknown> | undefined;
    const cost = er?.['total_cost_usd'];
    if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) {
      costs.push(cost);
    }
  }
  const medianDrafterCost = median(costs);

  // Median dispatch-to-merge minutes: correlate the latest invocation
  // for each settled plan with the plan-merge-settled atom timestamp.
  // Only counts plans that actually merged (we have a settled atom for).
  const settledByPlan = new Map<string, Atom>();
  for (const a of all) {
    if (a.type !== 'plan-merge-settled') continue;
    const m = (a.metadata ?? {}) as Record<string, unknown>;
    const planId = typeof m['plan_id'] === 'string' ? (m['plan_id'] as string) : null;
    if (!planId) continue;
    // Latest settled wins.
    const existing = settledByPlan.get(planId);
    if (!existing || (a.created_at ?? '') > (existing.created_at ?? '')) {
      settledByPlan.set(planId, a);
    }
  }

  // Latest invocation per plan id from the dispatch index.
  const invokedByPlan = new Map<string, Atom>();
  for (const a of invokedAll) {
    const m = (a.metadata ?? {}) as Record<string, unknown>;
    const planId = typeof m['plan_id'] === 'string' ? (m['plan_id'] as string) : null;
    if (!planId) continue;
    const existing = invokedByPlan.get(planId);
    // Earliest invocation per plan represents the FIRST dispatch: the
    // dispatch-to-merge clock starts then. A re-dispatch after a CR
    // round is part of the same lifecycle; counting from the latest
    // invocation would understate the operator-experienced wait.
    if (!existing || (a.created_at ?? '') < (existing.created_at ?? '')) {
      invokedByPlan.set(planId, a);
    }
  }

  // Dispatch-to-merge minutes: only counts plans we have BOTH an
  // invocation atom AND a settled atom for, since the duration is
  // meaningless without both endpoints. Backfilled or migration-era
  // settled atoms with no invocation peer are skipped here but still
  // count toward the headline `succeeded_in_window` ratio below.
  const dispatchToMergeMinutes: number[] = [];
  for (const [planId, settled] of settledByPlan) {
    const invoked = invokedByPlan.get(planId);
    if (!invoked) continue;
    const dispatchedTs = invoked.created_at ? Date.parse(invoked.created_at) : NaN;
    const settledTs = settled.created_at ? Date.parse(settled.created_at) : NaN;
    if (!Number.isFinite(dispatchedTs) || !Number.isFinite(settledTs)) continue;
    if (settledTs < dispatchedTs) continue; // sanity guard
    const minutes = (settledTs - dispatchedTs) / (60 * 1000);
    dispatchToMergeMinutes.push(minutes);
  }

  // Headline counts: succeeded_in_window and failed_in_window are
  // counted symmetrically off terminal-state evidence, NOT off the
  // invocation atom. The invocation gate would skew the ratio
  // pessimistic in backfilled or migration states (failures count,
  // successes drop). The duration-metric loop above retains the gate
  // because dispatch-to-merge minutes is meaningless without both
  // endpoints; the headline ratio reflects what actually happened, not
  // what was instrumented.
  let succeededInWindow = 0;
  for (const settled of settledByPlan.values()) {
    const settledTs = settled.created_at ? Date.parse(settled.created_at) : NaN;
    if (!Number.isFinite(settledTs) || settledTs < windowStart) continue;
    const m = (settled.metadata ?? {}) as Record<string, unknown>;
    const target = String(m['target_plan_state'] ?? '');
    if (target === 'succeeded') succeededInWindow += 1;
  }

  // Failed-in-window: plans whose dispatch_result.kind === 'error'
  // with `at` falling inside the window. This is a richer signal than
  // settled atoms because non-merged failures (drafter LLM, dirty
  // worktree, build) never reach the settled-atom path. Like
  // succeededInWindow above, no invocation gate is applied.
  let failedInWindow = 0;
  for (const p of plans) {
    const meta = (p.metadata ?? {}) as Record<string, unknown>;
    const dispatch = meta['dispatch_result'] as Record<string, unknown> | undefined;
    if (!dispatch) continue;
    if (dispatch['kind'] !== 'error') continue;
    const at = typeof dispatch['at'] === 'string' ? Date.parse(dispatch['at'] as string) : NaN;
    if (Number.isFinite(at) && at >= windowStart) failedInWindow += 1;
  }

  const medianDispatchToMerge = median(dispatchToMergeMinutes);

  // Median CR rounds per PR. Heuristic: count distinct pr-observation
  // atoms per plan_id and take the median across plans that had at
  // least one observation. Each observation roughly maps to a CR round
  // (pr-landing observes once per HEAD update and CR re-reviews on
  // each push). Lower-bound proxy until a richer CR-round atom exists.
  const observationsPerPlan = new Map<string, number>();
  for (const a of all) {
    if (a.type !== 'observation') continue;
    const m = (a.metadata ?? {}) as Record<string, unknown>;
    if (m['kind'] !== 'pr-observation') continue;
    const planId = typeof m['plan_id'] === 'string' ? (m['plan_id'] as string) : null;
    if (!planId) continue;
    observationsPerPlan.set(planId, (observationsPerPlan.get(planId) ?? 0) + 1);
  }
  const crRounds = Array.from(observationsPerPlan.values());
  const medianCrRounds = median(crRounds);

  // Recent failures: most recent 5 plans whose dispatch_result.kind is
  // 'error' AND whose `at` falls inside the dashboard window. The
  // window filter intersects symmetrically with `failed_in_window`
  // above so the operator's "what just broke" list never references a
  // failure that the headline counter excluded.
  const failureCandidates: MetricsRollupFailure[] = [];
  for (const p of plans) {
    const meta = (p.metadata ?? {}) as Record<string, unknown>;
    const dispatch = meta['dispatch_result'] as Record<string, unknown> | undefined;
    if (!dispatch) continue;
    if (dispatch['kind'] !== 'error') continue;
    const at = typeof dispatch['at'] === 'string' ? (dispatch['at'] as string) : null;
    const message = typeof dispatch['message'] === 'string' ? (dispatch['message'] as string) : '';
    if (!at) continue;
    const atTs = Date.parse(at);
    if (!Number.isFinite(atTs) || atTs < windowStart) continue;
    failureCandidates.push({
      plan_id: p.id,
      stage: extractFailureStage(message),
      message_preview: message.slice(0, 120),
      at,
    });
  }
  failureCandidates.sort((a, b) => b.at.localeCompare(a.at));
  const recentFailures = failureCandidates.slice(0, 5);

  return {
    window_hours: windowHours,
    atoms_total: all.length,
    atoms_in_window: atomsInWindow,
    plans: {
      total: plans.length,
      by_state: byState,
      success_rate: successRate,
    },
    autonomous_loop: {
      dispatched_in_window: invokedInWindow.length,
      succeeded_in_window: succeededInWindow,
      failed_in_window: failedInWindow,
      median_drafter_cost_usd: medianDrafterCost,
      median_dispatch_to_merge_minutes: medianDispatchToMerge,
      median_cr_rounds_per_pr: medianCrRounds,
    },
    recent_failures: recentFailures,
  };
}

// ---------------------------------------------------------------------------
// Live Ops snapshot: aggregated "what is the org doing right now" digest.
//
// One handler returns every section the Live Ops dashboard renders so
// the UI's 2s refresh cadence hits a single endpoint instead of seven.
// Pure projection over readAllAtoms() + the kill-switch state file —
// read-only by construction, every list capped at MAX_LIST_ITEMS.
//
// Helpers live in ./live-ops.ts so the time-window math is unit-tested
// without standing up the HTTP server (mirrors the security.ts +
// kill-switch-state.ts + metrics-rollup.ts pattern).
// ---------------------------------------------------------------------------

async function handleLiveOpsSnapshot(): Promise<LiveOpsSnapshot> {
  const all = await readAllAtoms();
  // The helpers consume a narrower atom shape; cast through unknown
  // because the helper-side type elides fields the helpers do not
  // touch (provenance, supersedes), keeping the public-surface
  // contract focused.
  const atomsForLiveOps = all as unknown as ReadonlyArray<LiveOpsAtom>;
  const now = Date.now();

  // Kill-switch posture stitches in via the existing reader so the
  // Live Ops + Control Panel views agree by construction. Reading the
  // state file synchronously here would block the event loop on slow
  // disks; we already read it via `readKillSwitchState` for
  // /api/kill-switch.state and rely on the same async path.
  const killSwitch = await readKillSwitchState();

  return {
    computed_at: new Date(now).toISOString(),
    heartbeat: computeLiveOpsHeartbeat(atomsForLiveOps, now),
    active_sessions: listLiveOpsActiveSessions(atomsForLiveOps, now),
    live_deliberations: listLiveOpsDeliberations(atomsForLiveOps, now),
    in_flight_executions: listLiveOpsInFlightExecutions(atomsForLiveOps, now),
    recent_transitions: listLiveOpsRecentTransitions(atomsForLiveOps, now),
    daemon_posture: computeLiveOpsDaemonPosture(
      atomsForLiveOps,
      now,
      killSwitch.tier,
      killSwitch.autonomyDial,
    ),
    pr_activity: listLiveOpsPrActivity(atomsForLiveOps, now),
  };
}

// ---------------------------------------------------------------------------
// Plan lifecycle: end-to-end timeline of a single plan's autonomous-loop
// chain. Stitches together the five (sometimes six) state-transition
// atoms that a `plan` traverses from operator-intent through to merged:
//
//   intent (operator-intent)
//     ↓ provenance.derived_from
//   plan (proposed → approved → executing → succeeded)
//     ↓ metadata.dispatch_result + a `code-author-invoked` observation
//   dispatch (PR opened)
//     ↓ pr-observation atoms (each new HEAD/review cycle)
//   merge (final pr-observation with pr_state=MERGED)
//     ↓ plan-merge-settled atom
//   settled
//
// All projections come straight from the AtomStore, no separate index.
// `readAllAtoms()` is already an O(1) in-memory map populated by the
// file-watcher; this handler does at most one full scan of that map and
// returns the structured `lifecycle` envelope the timeline UI consumes.
// ---------------------------------------------------------------------------

interface PlanLifecyclePhase {
  readonly phase:
    | 'deliberation'
    | 'approval'
    | 'dispatch'
    | 'observation'
    | 'merge'
    | 'settled'
    | 'failure';
  readonly label: string;
  readonly at: string;
  readonly by: string;
  readonly atom_id: string;
}

/*
 * Failure block: surfaces the dispatch_result.message that the
 * dispatcher already records on the plan atom when an executor halts
 * with `kind === 'error'`. The console previously rendered only the
 * `failed` state pill with no reason — operators had to grep
 * `.lag/atoms/<plan>.json` to find why. This block is the projection
 * the UI consumes; the raw atom remains the source of truth.
 *
 * `stage` is parsed out of the message via the executor's standard
 * shape `executor failed at stage=<stage>: <reason>`. Falls back to
 * `'unknown'` when the message doesn't match — better than failing
 * the whole lifecycle response.
 *
 * `fix_hint` is a small heuristic table keyed off `stage`. Keep it
 * mechanism-only here; vendor-specific failure modes belong in canon
 * + skill content, not the framework projection.
 */
interface PlanLifecycleFailure {
  readonly stage: string;
  readonly message: string;
  readonly at: string;
  readonly fix_hint: string | null;
}

interface PlanLifecycle {
  readonly plan: {
    readonly id: string;
    readonly content: string;
    readonly plan_state: string | null;
    readonly principal_id: string;
    readonly created_at: string;
    readonly layer: string;
  } | null;
  readonly intent: {
    readonly id: string;
    readonly content: string;
    readonly principal_id: string;
    readonly created_at: string;
  } | null;
  readonly approval: {
    readonly policy_atom_id: string | null;
    readonly approved_at: string;
    readonly approved_intent_id: string | null;
  } | null;
  readonly dispatch: {
    readonly atom_id: string | null;
    readonly pr_number: number | null;
    readonly pr_html_url: string | null;
    readonly branch_name: string | null;
    readonly commit_sha: string | null;
    readonly model: string | null;
    readonly total_cost_usd: number | null;
    readonly confidence: number | null;
    readonly dispatched_at: string;
    readonly principal_id: string;
  } | null;
  readonly observation: {
    readonly atom_id: string;
    readonly head_sha: string | null;
    readonly mergeable: string | null;
    readonly merge_state_status: string | null;
    readonly pr_state: string | null;
    readonly observed_at: string;
  } | null;
  readonly settled: {
    readonly atom_id: string;
    readonly target_plan_state: string | null;
    readonly settled_at: string;
    readonly pr_state: string | null;
  } | null;
  readonly failure: PlanLifecycleFailure | null;
  readonly transitions: ReadonlyArray<PlanLifecyclePhase>;
}

/*
 * Parse the executor's standard halt-shape "stage=<token>" out of a
 * dispatch_result.message. Tokens never contain whitespace or `:`,
 * which matches the sentinel set the executor emits today (e.g.
 * `apply-branch/dirty-worktree`, `cited-path-not-found`,
 * `llm-call-failed`). When no stage is found we return `'unknown'`
 * rather than null so the UI always has a non-empty pill — operators
 * still see "stage=unknown" + the full message and can act.
 */
function parseFailureStage(message: string): string {
  const match = message.match(/stage=([^\s:]+)/);
  return match && match[1] ? match[1] : 'unknown';
}

/*
 * Heuristic fix hints keyed by stage substring. Intentionally a small
 * lookup of recurring failure modes, not an exhaustive table. New
 * stages get added here only after they recur often enough to deserve
 * an automated nudge; one-offs stay in the message itself.
 */
function fixHintForStage(stage: string): string | null {
  if (stage.includes('dirty-worktree')) {
    return 'Run dispatch from a clean worktree (e.g. .worktrees/dispatch-runner).';
  }
  if (stage.includes('cited-path-not-found')) {
    return 'Drafter cited a path that does not exist. Check cited_paths against the working tree.';
  }
  if (stage.includes('llm-call-failed')) {
    return 'LLM call failed. Check Claude CLI exit code and stderr in the dispatch log.';
  }
  return null;
}

async function handlePlanLifecycle(planId: string): Promise<PlanLifecycle> {
  const all = await readAllAtoms();
  const byId = new Map(all.map((a) => [a.id, a]));
  const plan = byId.get(planId) ?? null;

  // Plan summary block.
  const planAny = plan as unknown as Record<string, unknown> | null;
  const planBlock: PlanLifecycle['plan'] = plan
    ? {
      id: plan.id,
      content: plan.content,
      plan_state: typeof planAny?.['plan_state'] === 'string'
        ? (planAny['plan_state'] as string)
        : null,
      principal_id: plan.principal_id,
      created_at: plan.created_at,
      layer: plan.layer,
    }
    : null;

  // Intent: the operator-intent atom in the plan's derived_from. Plans
  // can cite many ancestors (canon, prior plans). Pick the first
  // ancestor whose `type === 'operator-intent'` so we get the
  // governance-relevant trigger, not a canon citation.
  const planDerived = (plan?.provenance as { derived_from?: string[] } | undefined)?.derived_from ?? [];
  const intentAtom = planDerived
    .map((id) => byId.get(id))
    .find((a): a is Atom => Boolean(a) && a!.type === 'operator-intent') ?? null;
  const intentBlock: PlanLifecycle['intent'] = intentAtom
    ? {
      id: intentAtom.id,
      content: intentAtom.content,
      principal_id: intentAtom.principal_id,
      created_at: intentAtom.created_at,
    }
    : null;

  // Approval: read straight from plan.metadata.approved_at + approved_via.
  // The approval is encoded inline on the plan rather than as a
  // separate atom, but it's still a discrete state transition the
  // operator wants visible.
  const meta = (plan?.metadata ?? {}) as Record<string, unknown>;
  const approvedAt = typeof meta['approved_at'] === 'string' ? meta['approved_at'] as string : null;
  const approvedVia = typeof meta['approved_via'] === 'string' ? meta['approved_via'] as string : null;
  const approvedIntent = typeof meta['approved_intent_id'] === 'string' ? meta['approved_intent_id'] as string : null;
  const approvalBlock: PlanLifecycle['approval'] = approvedAt
    ? {
      policy_atom_id: approvedVia,
      approved_at: approvedAt,
      approved_intent_id: approvedIntent,
    }
    : null;

  // Dispatch: derived from BOTH the inline `dispatch_result` summary on
  // the plan AND the corresponding `<actor>-invoked-...` observation
  // atom that carries the rich payload (pr_number, branch_name,
  // commit_sha, model, cost). Inline `dispatch_result` is intentionally
  // a thin pointer; the observation is the source of truth for fields.
  // We prefer the observation when present and fall back to whatever
  // the inline summary carries.
  const inlineDispatch = (meta['dispatch_result'] as Record<string, unknown> | undefined) ?? null;
  const inlineDispatchedAt = typeof inlineDispatch?.['at'] === 'string'
    ? (inlineDispatch['at'] as string)
    : null;

  // Find the `*-invoked-<plan-id>-...` observation atom whose metadata
  // points at this plan via plan_id. Every executor (code-author,
  // pr-fix, etc.) writes one of these on dispatch.
  // Latest dispatch wins, mirroring the pr-observation and
  // plan-merge-settled loops below: when a plan is re-dispatched, the
  // most recent invocation carries the live pr_number / commit_sha /
  // model_used. Picking the earliest would silently surface stale data.
  let invokedObservation: Atom | null = null;
  for (const a of all) {
    if (a.type !== 'observation') continue;
    const m = (a.metadata ?? {}) as Record<string, unknown>;
    if (m['kind'] !== 'code-author-invoked' && !String(m['kind'] ?? '').endsWith('-invoked')) continue;
    if (m['plan_id'] !== planId) continue;
    if (!invokedObservation || (a.created_at ?? '') > (invokedObservation.created_at ?? '')) {
      invokedObservation = a;
    }
  }
  const executorResult = invokedObservation
    ? ((invokedObservation.metadata as Record<string, unknown>)['executor_result'] as Record<string, unknown> | undefined) ?? null
    : null;
  const dispatchBlock: PlanLifecycle['dispatch'] = (invokedObservation || inlineDispatch)
    ? {
      atom_id: invokedObservation?.id ?? null,
      pr_number: typeof executorResult?.['pr_number'] === 'number'
        ? (executorResult['pr_number'] as number)
        : null,
      pr_html_url: typeof executorResult?.['pr_html_url'] === 'string'
        ? (executorResult['pr_html_url'] as string)
        : null,
      branch_name: typeof executorResult?.['branch_name'] === 'string'
        ? (executorResult['branch_name'] as string)
        : null,
      commit_sha: typeof executorResult?.['commit_sha'] === 'string'
        ? (executorResult['commit_sha'] as string)
        : null,
      model: typeof executorResult?.['model_used'] === 'string'
        ? (executorResult['model_used'] as string)
        : null,
      total_cost_usd: typeof executorResult?.['total_cost_usd'] === 'number'
        ? (executorResult['total_cost_usd'] as number)
        : null,
      confidence: typeof executorResult?.['confidence'] === 'number'
        ? (executorResult['confidence'] as number)
        : null,
      dispatched_at: invokedObservation?.created_at ?? inlineDispatchedAt ?? '',
      principal_id: invokedObservation?.principal_id ?? 'unknown',
    }
    : null;

  // Observation: the most recent pr-observation atom that derives from
  // this plan. The PR observation runner emits one per HEAD update;
  // we surface the latest as the canonical "current state of PR" view.
  let latestPrObservation: Atom | null = null;
  for (const a of all) {
    if (a.type !== 'observation') continue;
    const m = (a.metadata ?? {}) as Record<string, unknown>;
    if (m['kind'] !== 'pr-observation') continue;
    if (m['plan_id'] !== planId) continue;
    if (!latestPrObservation || (a.created_at ?? '') > (latestPrObservation.created_at ?? '')) {
      latestPrObservation = a;
    }
  }
  const observationBlock: PlanLifecycle['observation'] = latestPrObservation
    ? {
      atom_id: latestPrObservation.id,
      head_sha: typeof (latestPrObservation.metadata as Record<string, unknown>)['head_sha'] === 'string'
        ? (latestPrObservation.metadata as Record<string, unknown>)['head_sha'] as string
        : null,
      mergeable: typeof (latestPrObservation.metadata as Record<string, unknown>)['mergeable'] === 'string'
        ? (latestPrObservation.metadata as Record<string, unknown>)['mergeable'] as string
        : null,
      merge_state_status: typeof (latestPrObservation.metadata as Record<string, unknown>)['merge_state_status'] === 'string'
        ? (latestPrObservation.metadata as Record<string, unknown>)['merge_state_status'] as string
        : null,
      pr_state: typeof (latestPrObservation.metadata as Record<string, unknown>)['pr_state'] === 'string'
        ? (latestPrObservation.metadata as Record<string, unknown>)['pr_state'] as string
        : null,
      observed_at: latestPrObservation.created_at,
    }
    : null;

  // Settled: the plan-merge-settled atom referencing this plan.
  let settledAtom: Atom | null = null;
  for (const a of all) {
    if (a.type !== 'plan-merge-settled') continue;
    const m = (a.metadata ?? {}) as Record<string, unknown>;
    if (m['plan_id'] !== planId) continue;
    if (!settledAtom || (a.created_at ?? '') > (settledAtom.created_at ?? '')) {
      settledAtom = a;
    }
  }
  const settledBlock: PlanLifecycle['settled'] = settledAtom
    ? {
      atom_id: settledAtom.id,
      target_plan_state: typeof (settledAtom.metadata as Record<string, unknown>)['target_plan_state'] === 'string'
        ? (settledAtom.metadata as Record<string, unknown>)['target_plan_state'] as string
        : null,
      settled_at: settledAtom.created_at,
      pr_state: typeof (settledAtom.metadata as Record<string, unknown>)['pr_state'] === 'string'
        ? (settledAtom.metadata as Record<string, unknown>)['pr_state'] as string
        : null,
    }
    : null;

  /*
   * Failure: when plan_state is `failed` the dispatcher already wrote
   * a `dispatch_result` envelope on the plan describing the halt. We
   * project that out so the UI never has to read raw metadata. We
   * accept either an inline `stage` field or one parsed out of the
   * message — the executor records both shapes today.
   */
  const planStateValue = typeof planAny?.['plan_state'] === 'string'
    ? (planAny['plan_state'] as string)
    : null;
  let failureBlock: PlanLifecycleFailure | null = null;
  if (planStateValue === 'failed' && inlineDispatch && inlineDispatch['kind'] === 'error') {
    const message = typeof inlineDispatch['message'] === 'string'
      ? (inlineDispatch['message'] as string)
      : '';
    const at = typeof inlineDispatch['at'] === 'string'
      ? (inlineDispatch['at'] as string)
      : (plan?.created_at ?? '');
    const stage = typeof inlineDispatch['stage'] === 'string' && (inlineDispatch['stage'] as string).length > 0
      ? (inlineDispatch['stage'] as string)
      : parseFailureStage(message);
    failureBlock = {
      stage,
      message,
      at,
      fix_hint: fixHintForStage(stage),
    };
  }

  // Compose the chronological transitions list. Each present block
  // contributes one phase entry; absent phases are simply omitted.
  // The frontend renders this as a vertical timeline with stagger
  // animation, so order is load-bearing.
  const transitions: PlanLifecyclePhase[] = [];
  if (intentBlock) {
    transitions.push({
      phase: 'deliberation',
      label: 'Operator intent',
      at: intentBlock.created_at,
      by: intentBlock.principal_id,
      atom_id: intentBlock.id,
    });
  }
  if (planBlock) {
    transitions.push({
      phase: 'deliberation',
      label: 'Plan proposed',
      at: planBlock.created_at,
      by: planBlock.principal_id,
      atom_id: planBlock.id,
    });
  }
  if (approvalBlock) {
    transitions.push({
      phase: 'approval',
      label: 'Plan approved',
      at: approvalBlock.approved_at,
      by: approvalBlock.policy_atom_id ?? 'policy',
      atom_id: planBlock?.id ?? planId,
    });
  }
  if (dispatchBlock && dispatchBlock.dispatched_at) {
    transitions.push({
      phase: 'dispatch',
      label: dispatchBlock.pr_number
        ? `Dispatched (PR #${dispatchBlock.pr_number})`
        : 'Dispatched',
      at: dispatchBlock.dispatched_at,
      by: dispatchBlock.principal_id,
      atom_id: dispatchBlock.atom_id ?? planId,
    });
  }
  if (observationBlock) {
    transitions.push({
      phase: 'observation',
      label: observationBlock.pr_state
        ? `PR observed (${observationBlock.pr_state})`
        : 'PR observed',
      at: observationBlock.observed_at,
      // Read the signing principal from the atom rather than hardcoding
      // a role name. The pr-observation atom is signed by whichever
      // actor produced it (pr-landing-agent today, but BYO adapters
      // can sign as anything else). Pinning a literal here lies to
      // the operator about provenance.
      by: latestPrObservation?.principal_id ?? 'unknown',
      atom_id: observationBlock.atom_id,
    });
  }
  if (settledBlock) {
    transitions.push({
      phase: settledBlock.pr_state === 'MERGED' ? 'merge' : 'settled',
      label: `Plan settled${settledBlock.target_plan_state ? ` → ${settledBlock.target_plan_state}` : ''}`,
      at: settledBlock.settled_at,
      // Same: the plan-merge-settled atom is signed by the reconciler
      // (currently `inbox-runtime`), NOT by pr-landing-agent. Read
      // the principal from the atom to keep attribution honest.
      by: settledAtom?.principal_id ?? 'unknown',
      atom_id: settledBlock.atom_id,
    });
  }
  /*
   * Failure transition slots in chronologically via the sort below.
   * `by: 'plan-dispatcher'` is a logical attribution for the halt —
   * the dispatch_result envelope is written by whichever component
   * caught the executor error, but the operator-facing label stays
   * stable so the timeline reads consistently across actors.
   */
  if (failureBlock && plan) {
    transitions.push({
      phase: 'failure',
      label: 'Plan failed',
      at: failureBlock.at,
      by: 'plan-dispatcher',
      atom_id: plan.id,
    });
  }
  // Stable chronological sort. Ties keep insertion order, which is
  // already domain-meaningful (plan-proposed before approval, etc.).
  transitions.sort((a, b) => a.at.localeCompare(b.at));

  return {
    plan: planBlock,
    intent: intentBlock,
    approval: approvalBlock,
    dispatch: dispatchBlock,
    observation: observationBlock,
    settled: settledBlock,
    failure: failureBlock,
    transitions,
  };
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

  if (path === '/api/principals.stats' && req.method === 'POST') {
    try {
      const data = await handlePrincipalsStats();
      sendOk(req, res, data);
    } catch (err) {
      sendErr(req, res, 500, 'principals-stats-failed', (err as Error).message);
    }
    return;
  }

  if (path === '/api/principals.tree' && req.method === 'POST') {
    try {
      const data = await handlePrincipalsTree();
      sendOk(req, res, data);
    } catch (err) {
      sendErr(req, res, 500, 'principals-tree-failed', (err as Error).message);
    }
    return;
  }

  if (path === '/api/principals.skill' && req.method === 'POST') {
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const pid = body['principal_id'];
    if (typeof pid !== 'string' || pid.length === 0) {
      sendErr(req, res, 400, 'principal-skill-bad-request', 'principal_id (string) required');
      return;
    }
    try {
      const data = await handlePrincipalSkill({ principal_id: pid });
      sendOk(req, res, data);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.startsWith('invalid principal_id')) {
        sendErr(req, res, 400, 'principal-skill-bad-request', msg);
      } else {
        sendErr(req, res, 500, 'principal-skill-failed', msg);
      }
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

  /*
   * Actor activity stream. The endpoint name carries `.stream` to
   * reserve the slot for an SSE/WebSocket variant in v2; v1 is a
   * single-shot poll that the client invokes via TanStack Query's
   * refetchInterval. Wire payload is bounded server-side regardless
   * of caller-supplied limit (DoS defense -- ACTOR_ACTIVITY_MAX_LIMIT).
   */
  if (path === '/api/actor-activity.stream' && req.method === 'POST') {
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const bodyLimit = body['limit'];
    const bodyPrincipal = body['principal_id'];
    const bodyExclude = body['exclude_types'];
    const limit = typeof bodyLimit === 'number' ? bodyLimit : undefined;
    const principal_id = typeof bodyPrincipal === 'string' && bodyPrincipal.length > 0
      ? bodyPrincipal
      : undefined;
    /*
     * Per-principal feed defaults to suppressing 'question' atoms.
     * Question atoms are sub-events of plan deliberation (the planner
     * raised an internal Q&A inside a plan); they're noise in a "what
     * did this principal DO" surface and clicking them dead-ends in the
     * canon view via routeForAtomId's default fallback. The global
     * feed (no principal_id) shows everything; an explicit
     * `exclude_types` array in the body always wins so a future caller
     * can pass `[]` to disable the default or a longer list to suppress
     * additional sub-event types.
     */
    const exclude_types: ReadonlyArray<string> | undefined = Array.isArray(bodyExclude)
      ? (bodyExclude.filter((t): t is string => typeof t === 'string' && t.length > 0))
      : (principal_id !== undefined ? ['question'] : undefined);
    const params: { limit?: number; principal_id?: string; exclude_types?: ReadonlyArray<string> } = {
      ...(limit !== undefined ? { limit } : {}),
      ...(principal_id !== undefined ? { principal_id } : {}),
      ...(exclude_types !== undefined ? { exclude_types } : {}),
    };
    try {
      const data = await handleActorActivityStream(params);
      sendOk(req, res, data);
    } catch (err) {
      sendErr(req, res, 500, 'actor-activity-failed', (err as Error).message);
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
    /*
     * Read-only contract: the console is a projection over the atom
     * store by default. Atom proposals are an opt-in dev affordance.
     * See `ALLOW_CONSOLE_WRITES` declaration for the full rationale +
     * apps/console/CLAUDE.md for the operator-facing documentation.
     */
    if (!ALLOW_CONSOLE_WRITES) {
      sendErr(
        req,
        res,
        403,
        'console-read-only',
        'Console v1 is read-only. Set LAG_CONSOLE_ALLOW_WRITES=1 to enable atoms.propose, or use `node scripts/decide.mjs` for canon proposals.',
      );
      return;
    }
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

  if (path === '/api/canon-suggestions.list' && req.method === 'POST') {
    /*
     * READ-ONLY endpoint per apps/console v1 scope boundary. The
     * operator triages via the canon-suggest-triage CLI (which writes
     * the state change) — this endpoint never mutates atom metadata.
     * Default review_state=pending so a typical request returns the
     * inbox of suggestions awaiting operator review; pass
     * review_state=promoted|dismissed|deferred to see the audit trail.
     */
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const raw = typeof body['review_state'] === 'string' ? (body['review_state'] as string) : 'pending';
    if (!CANON_SUGGESTION_REVIEW_STATES.includes(raw as CanonSuggestionReviewState)) {
      sendErr(req, res, 400, 'invalid-review-state', `review_state must be one of ${CANON_SUGGESTION_REVIEW_STATES.join('|')}`);
      return;
    }
    try {
      const data = await handleCanonSuggestionsList({ review_state: raw as CanonSuggestionReviewState });
      sendOk(req, res, data);
    } catch (err) {
      sendErr(req, res, 500, 'canon-suggestions-list-failed', (err as Error).message);
    }
    return;
  }

  if (path === '/api/control.status' && req.method === 'POST') {
    /*
     * Operator control-panel projection. Read-only: MUST NOT mutate
     * the STOP sentinel from this code path. See handleControlStatus
     * JSDoc for the full read-only contract.
     */
    try {
      const data = await handleControlStatus();
      sendOk(req, res, data);
    } catch (err) {
      sendErr(req, res, 500, 'control-status-failed', (err as Error).message);
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

  if (path === '/api/metrics.rollup' && req.method === 'POST') {
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const rawWindow = body['window_hours'];
    const windowHours = typeof rawWindow === 'number' && Number.isFinite(rawWindow) && rawWindow > 0
      ? Math.trunc(rawWindow)
      : undefined;
    try {
      const data = await handleMetricsRollup(
        windowHours !== undefined ? { window_hours: windowHours } : {},
      );
      sendOk(req, res, data);
    } catch (err) {
      sendErr(req, res, 500, 'metrics-rollup-failed', (err as Error).message);
    }
    return;
  }

  if (path === '/api/live-ops.snapshot' && req.method === 'POST') {
    /*
     * Read-only aggregate digest. Takes no parameters today; the time
     * windows (60s, 5m, 1h, 15m, 24h) are encoded in the helpers.
     * Future extensions (custom windows, per-section toggles) would
     * accept a body, but v1 keeps the wire shape minimal so the UI
     * can pin a single TanStack Query key + 2s refetchInterval.
     */
    try {
      const data = await handleLiveOpsSnapshot();
      sendOk(req, res, data);
    } catch (err) {
      sendErr(req, res, 500, 'live-ops-snapshot-failed', (err as Error).message);
    }
    return;
  }

  if (path === '/api/plan.lifecycle' && req.method === 'POST') {
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const planId = typeof body['plan_id'] === 'string' ? (body['plan_id'] as string) : '';
    if (!planId) {
      sendErr(req, res, 400, 'missing-plan-id', 'plan.lifecycle requires { plan_id: string }');
      return;
    }
    try {
      const data = await handlePlanLifecycle(planId);
      sendOk(req, res, data);
    } catch (err) {
      sendErr(req, res, 500, 'plan-lifecycle-failed', (err as Error).message);
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
