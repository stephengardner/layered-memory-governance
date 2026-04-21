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

  // SSE stub: per canon dev-web-realtime-ready-transport, the
  // endpoint exists from day 1 even though v1 just sends a ping
  // every 30s. Feature code subscribing here will seamlessly pick
  // up real atom-change events when the backend wires file-watching
  // or the LAG daemon publishes change notifications.
  if (path.startsWith('/api/events/') && req.method === 'GET') {
    const channel = path.substring('/api/events/'.length);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`event: open\ndata: ${JSON.stringify({ channel, at: new Date().toISOString() })}\n\n`);
    const interval = setInterval(() => {
      res.write(`event: ping\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
    }, 30_000);
    req.on('close', () => clearInterval(interval));
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

server.listen(PORT, () => {
  console.log(`[backend] LAG Console backend listening on http://localhost:${PORT}`);
  console.log(`[backend] reading atoms from ${ATOMS_DIR}`);
});

// Clean shutdown for dev watch reloads.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`[backend] received ${sig}; closing`);
    server.close(() => process.exit(0));
  });
}
