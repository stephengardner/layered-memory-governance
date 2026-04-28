#!/usr/bin/env node
/**
 * PostToolUse hook: emit an agent-turn atom representing operator
 * activity in this throttled time-window so the pulse dashboard's
 * "active sessions" view stays warm during operator-led terminal
 * work.
 *
 * Throttle (default 60s) keeps atom volume bounded: a session that
 * fires 200 tool calls writes ~3-5 atoms, not 200. The
 * tool_calls_in_window count carries the underlying activity rate
 * for downstream analytics.
 *
 * Sidecar state at `.lag/operator-session-state/<session_id>.json`
 * tracks lastTurnAtMs + lastTurnNumber + toolsSinceLastTurn between
 * hook invocations. The sidecar is gitignored (under .lag/) and
 * cleaned up on Stop.
 *
 * Fail-open per the standard hook contract: any error exits 0 so a
 * hook bug never wedges the session.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  buildOperatorTurnAtom,
  operatorSessionAtomId,
  parseHookPayload,
  shouldEmitTurn,
} from '../../scripts/lib/operator-claude-session.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');
const SIDECAR_DIR = resolve(STATE_DIR, 'operator-session-state');

const PRINCIPAL_ID = process.env.LAG_OPERATOR_ID || 'apex-agent';
const MODEL_ID = process.env.LAG_OPERATOR_MODEL_ID || 'claude-opus-4-7';
/*
 * Throttle window in ms. Tunable via env so a deployment that wants
 * finer-grained pulse fidelity can lower it without code edits;
 * default 60s matches the pulse dashboard's typical bucket size.
 */
const THROTTLE_MS = Number.parseInt(process.env.LAG_OPERATOR_HEARTBEAT_THROTTLE_MS ?? '', 10) || 60_000;

async function readSidecar(sessionId) {
  const path = resolve(SIDECAR_DIR, `${sessionId}.json`);
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    return {
      lastTurnAtMs: typeof parsed.lastTurnAtMs === 'number' ? parsed.lastTurnAtMs : null,
      lastTurnNumber: typeof parsed.lastTurnNumber === 'number' ? parsed.lastTurnNumber : 0,
      toolsSinceLastTurn: typeof parsed.toolsSinceLastTurn === 'number' ? parsed.toolsSinceLastTurn : 0,
    };
  } catch {
    return null;
  }
}

async function writeSidecar(sessionId, state) {
  const path = resolve(SIDECAR_DIR, `${sessionId}.json`);
  await mkdir(SIDECAR_DIR, { recursive: true });
  await writeFile(path, JSON.stringify(state), 'utf8');
}

async function main() {
  const raw = await readStdin();
  const payload = parseHookPayload(raw);
  if (payload === null) {
    process.exit(0);
  }

  const sessionId = payload.session_id;
  const nowMs = Date.now();
  const prior = (await readSidecar(sessionId)) ?? {
    lastTurnAtMs: null,
    lastTurnNumber: 0,
    toolsSinceLastTurn: 0,
  };
  const toolsThisWindow = prior.toolsSinceLastTurn + 1;

  if (!shouldEmitTurn(prior.lastTurnAtMs, nowMs, THROTTLE_MS)) {
    /*
     * Within the throttle window: no atom. Just bump the in-window
     * tool count so the next emitted heartbeat carries it.
     */
    await writeSidecar(sessionId, {
      lastTurnAtMs: prior.lastTurnAtMs,
      lastTurnNumber: prior.lastTurnNumber,
      toolsSinceLastTurn: toolsThisWindow,
    });
    process.exit(0);
  }

  const turnNumber = prior.lastTurnNumber + 1;
  const startedAt = new Date(nowMs).toISOString();
  const atom = buildOperatorTurnAtom({
    sessionId,
    sessionAtomId: operatorSessionAtomId(sessionId),
    principalId: PRINCIPAL_ID,
    startedAt,
    completedAt: startedAt,
    modelId: MODEL_ID,
    turnNumber,
    toolCallsInWindow: toolsThisWindow,
  });

  await mkdir(STATE_DIR, { recursive: true });
  const { createFileHost } = await import('../../dist/adapters/file/index.js');
  const host = await createFileHost({ rootDir: STATE_DIR });
  await host.atoms.put(atom);

  await writeSidecar(sessionId, {
    lastTurnAtMs: nowMs,
    lastTurnNumber: turnNumber,
    toolsSinceLastTurn: 0,
  });
  process.exit(0);
}

function readStdin() {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[operator-session-heartbeat] error (fail-open):', err);
  process.exit(0);
});
