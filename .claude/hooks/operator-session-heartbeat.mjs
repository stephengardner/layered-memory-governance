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
 * for downstream analytics under the canonical
 * AgentTurnMeta.extra.tool_calls_in_window slot.
 *
 * Concurrency: PostToolUse can fire concurrently when Claude Code
 * batches independent tool calls. The sidecar read-modify-write at
 * `.lag/operator-session-state/<session_id>.json` is therefore
 * serialized via an O_EXCL `.lock` file so two concurrent hook
 * invocations cannot both increment lastTurnNumber (which would
 * collide on the same agent-turn-op-<sid>-N atom id).
 *
 * Identity: same LAG_OPERATOR_ID guard as the SessionStart hook;
 * skip-with-warning if missing.
 *
 * Fail-open: any error exits 0 so a hook bug never wedges the
 * session.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  acquireSidecarLock,
  buildOperatorTurnAtom,
  operatorSessionAtomId,
  parseHookPayload,
  readHookStdin,
  shouldEmitTurn,
} from '../../scripts/lib/operator-claude-session.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');
const SIDECAR_DIR = resolve(STATE_DIR, 'operator-session-state');

const PRINCIPAL_ID = process.env.LAG_OPERATOR_ID;
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
      lastTurnIndex: typeof parsed.lastTurnIndex === 'number' ? parsed.lastTurnIndex : -1,
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
  if (!PRINCIPAL_ID || PRINCIPAL_ID.length === 0) {
    console.error('[operator-session-heartbeat] LAG_OPERATOR_ID not set; skipping heartbeat emission');
    process.exit(0);
  }

  const raw = await readHookStdin();
  const payload = parseHookPayload(raw);
  if (payload === null) {
    process.exit(0);
  }

  const sessionId = payload.session_id;

  await mkdir(SIDECAR_DIR, { recursive: true });
  const lockPath = resolve(SIDECAR_DIR, `${sessionId}.lock`);
  const lock = await acquireSidecarLock(lockPath);
  try {
    const nowMs = Date.now();
    const prior = (await readSidecar(sessionId)) ?? {
      lastTurnAtMs: null,
      /*
       * Sentinel -1 so the first emit increments to turnIndex=0
       * (canonical AgentTurnMeta uses 0-based indexing per
       * src/substrate/types.ts).
       */
      lastTurnIndex: -1,
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
        lastTurnIndex: prior.lastTurnIndex,
        toolsSinceLastTurn: toolsThisWindow,
      });
      return;
    }

    const turnIndex = prior.lastTurnIndex + 1;
    const startedAt = new Date(nowMs).toISOString();
    const atom = buildOperatorTurnAtom({
      sessionId,
      sessionAtomId: operatorSessionAtomId(sessionId),
      principalId: PRINCIPAL_ID,
      startedAt,
      completedAt: startedAt,
      modelId: MODEL_ID,
      turnIndex,
      toolCallsInWindow: toolsThisWindow,
    });

    await mkdir(STATE_DIR, { recursive: true });
    const { createFileHost } = await import('../../dist/adapters/file/index.js');
    const host = await createFileHost({ rootDir: STATE_DIR });
    await host.atoms.put(atom);

    await writeSidecar(sessionId, {
      lastTurnAtMs: nowMs,
      lastTurnIndex: turnIndex,
      toolsSinceLastTurn: 0,
    });
  } finally {
    await lock.release();
  }
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[operator-session-heartbeat] error (fail-open):', err);
  process.exit(0);
});
