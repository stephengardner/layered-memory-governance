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
// Atom reader.
// ---------------------------------------------------------------------------

async function readAllAtoms(): Promise<Atom[]> {
  let entries: string[];
  try {
    entries = await readdir(ATOMS_DIR);
  } catch (err) {
    console.error(`[backend] could not read ${ATOMS_DIR}: ${(err as Error).message}`);
    return [];
  }
  const files = entries.filter((n) => n.endsWith('.json'));
  const atoms: Atom[] = [];
  for (const name of files) {
    try {
      const raw = await readFile(join(ATOMS_DIR, name), 'utf8');
      const parsed = JSON.parse(raw) as Atom;
      atoms.push(parsed);
    } catch (err) {
      console.warn(`[backend] skipping malformed atom ${name}: ${(err as Error).message}`);
    }
  }
  return atoms;
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
  // Stable sort: by type, then id, so UI ordering is deterministic.
  out.sort((a, b) => (a.type === b.type ? a.id.localeCompare(b.id) : a.type.localeCompare(b.type)));
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

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(payload));
}

function sendOk<T>(res: ServerResponse, data: T): void {
  sendJson(res, 200, { ok: true, data });
}

function sendErr(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { ok: false, error: { code, message } });
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
  // CORS preflight.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const path = url.pathname;

  if (path === '/api/health') {
    sendOk(res, { ok: true, lagDir: LAG_DIR, atomsDir: ATOMS_DIR });
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
      sendOk(res, data);
    } catch (err) {
      sendErr(res, 500, 'canon-list-failed', (err as Error).message);
    }
    return;
  }

  if (path === '/api/canon.stats' && req.method === 'POST') {
    try {
      const data = await handleCanonStats();
      sendOk(res, data);
    } catch (err) {
      sendErr(res, 500, 'canon-stats-failed', (err as Error).message);
    }
    return;
  }

  if (path === '/api/principals.list' && req.method === 'POST') {
    try {
      const data = await handlePrincipalsList();
      sendOk(res, data);
    } catch (err) {
      sendErr(res, 500, 'principals-list-failed', (err as Error).message);
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
      sendOk(res, data);
    } catch (err) {
      sendErr(res, 500, 'activities-list-failed', (err as Error).message);
    }
    return;
  }

  if (path === '/api/atoms.chain' && req.method === 'POST') {
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const id = typeof body['id'] === 'string' ? (body['id'] as string) : '';
    const depth = typeof body['depth'] === 'number' ? (body['depth'] as number) : 5;
    if (!id) { sendErr(res, 400, 'missing-id', 'atoms.chain requires { id: string }'); return; }
    try {
      const data = await handleAtomChain(id, depth);
      sendOk(res, data);
    } catch (err) {
      sendErr(res, 500, 'atoms-chain-failed', (err as Error).message);
    }
    return;
  }

  if (path === '/api/atoms.cascade' && req.method === 'POST') {
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const id = typeof body['id'] === 'string' ? (body['id'] as string) : '';
    const depth = typeof body['depth'] === 'number' ? (body['depth'] as number) : 5;
    if (!id) { sendErr(res, 400, 'missing-id', 'atoms.cascade requires { id: string }'); return; }
    try {
      const data = await handleAtomCascade(id, depth);
      sendOk(res, data);
    } catch (err) {
      sendErr(res, 500, 'atoms-cascade-failed', (err as Error).message);
    }
    return;
  }

  if (path === '/api/arbitration.compare' && req.method === 'POST') {
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const a = typeof body['a'] === 'string' ? (body['a'] as string) : '';
    const b = typeof body['b'] === 'string' ? (body['b'] as string) : '';
    if (!a || !b) { sendErr(res, 400, 'missing-ids', 'arbitration.compare requires { a, b }'); return; }
    try {
      const data = await handleArbitrationCompare(a, b);
      sendOk(res, data);
    } catch (err) {
      sendErr(res, 500, 'arbitration-compare-failed', (err as Error).message);
    }
    return;
  }

  if (path === '/api/atoms.references' && req.method === 'POST') {
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const id = typeof body['id'] === 'string' ? (body['id'] as string) : '';
    if (!id) {
      sendErr(res, 400, 'missing-id', 'atoms.references requires { id: string }');
      return;
    }
    try {
      const data = await handleAtomReferences(id);
      sendOk(res, data);
    } catch (err) {
      sendErr(res, 500, 'atoms-references-failed', (err as Error).message);
    }
    return;
  }

  if (path === '/api/canon.drift' && req.method === 'POST') {
    try {
      const data = await handleDriftReport();
      sendOk(res, data);
    } catch (err) {
      sendErr(res, 500, 'canon-drift-failed', (err as Error).message);
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
      sendOk(res, state);
    } catch (err) {
      sendErr(res, 500, 'kill-switch-state-failed', (err as Error).message);
    }
    return;
  }

  if (path === '/api/daemon.status' && req.method === 'POST') {
    try {
      const data = await handleDaemonStatus();
      sendOk(res, data);
    } catch (err) {
      sendErr(res, 500, 'daemon-status-failed', (err as Error).message);
    }
    return;
  }

  if (path === '/api/plans.list' && req.method === 'POST') {
    try {
      const data = await handlePlansList();
      sendOk(res, data);
    } catch (err) {
      sendErr(res, 500, 'plans-list-failed', (err as Error).message);
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

  sendErr(res, 404, 'not-found', `no handler for ${req.method} ${path}`);
}

// ---------------------------------------------------------------------------
// Server start.
// ---------------------------------------------------------------------------

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('[backend] unhandled:', err);
    if (!res.headersSent) sendErr(res, 500, 'internal', (err as Error).message);
  });
});

const atomSubscribers = new Set<ServerResponse>();
const knownAtomFiles = new Set<string>();

async function primeAtomIndex(): Promise<void> {
  try {
    const entries = await readdir(ATOMS_DIR);
    for (const e of entries) if (e.endsWith('.json')) knownAtomFiles.add(e);
  } catch { /* no atoms dir yet; watcher will still fire */ }
}

function broadcastAtomEvent(event: string, payload: unknown): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const sub of atomSubscribers) {
    try { sub.write(msg); } catch { atomSubscribers.delete(sub); }
  }
}

async function startAtomWatcher(): Promise<void> {
  await primeAtomIndex();
  try {
    fsWatch(ATOMS_DIR, { persistent: false }, (eventType, filename) => {
      if (!filename || !filename.endsWith('.json')) return;
      // `rename` fires on create / delete / move. `change` on write.
      // Diff against knownAtomFiles to classify.
      if (eventType === 'rename') {
        // File may have appeared or disappeared; test existence lazily
        // via the next readdir from any subscriber — simpler than
        // a second stat call per event.
        if (knownAtomFiles.has(filename)) {
          // Possibly deleted; we don't re-list here to stay cheap.
        } else {
          knownAtomFiles.add(filename);
          const id = filename.replace(/\.json$/, '');
          broadcastAtomEvent('atom.created', { id, at: new Date().toISOString() });
        }
      } else if (eventType === 'change') {
        const id = filename.replace(/\.json$/, '');
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
