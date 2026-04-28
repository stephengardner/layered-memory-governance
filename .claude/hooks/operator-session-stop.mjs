#!/usr/bin/env node
/**
 * Stop hook: finalize the agent-session atom for this operator
 * session so the pulse dashboard's "active sessions" view stops
 * listing it.
 *
 * The substrate's `listActiveSessions` (apps/console/server/live-ops.ts)
 * filters out sessions whose agent_session.completed_at is set and
 * whose latest turn is outside the active-window. By writing
 * completed_at + terminal_state here, we cleanly retire the session
 * from the dashboard.
 *
 * Also cleans up the sidecar state file so a subsequent session with
 * the same session_id (rare but possible on re-invocation) starts
 * fresh.
 *
 * Fail-open: any internal error exits 0.
 *
 * Stop is fired multiple times per session (every time the assistant
 * yields). We make the write idempotent (write completion always; the
 * latest write wins) rather than try to detect the "real" termination.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlink } from 'node:fs/promises';
import {
  operatorSessionAtomId,
  parseHookPayload,
  withSessionCompletion,
} from '../../scripts/lib/operator-claude-session.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');
const SIDECAR_DIR = resolve(STATE_DIR, 'operator-session-state');

async function main() {
  const raw = await readStdin();
  const payload = parseHookPayload(raw);
  if (payload === null) {
    process.exit(0);
  }

  const sessionId = payload.session_id;
  const completedAt = new Date().toISOString();

  const { createFileHost } = await import('../../dist/adapters/file/index.js');
  const host = await createFileHost({ rootDir: STATE_DIR });
  const sessionAtomId = operatorSessionAtomId(sessionId);
  const existing = await host.atoms.get(sessionAtomId);
  if (existing !== null) {
    const updated = withSessionCompletion(existing, { completedAt });
    await host.atoms.put(updated);
  }

  /*
   * Sidecar cleanup. Best-effort: missing file is fine (the heartbeat
   * hook may not have fired yet for a very short session).
   */
  try {
    await unlink(resolve(SIDECAR_DIR, `${sessionId}.json`));
  } catch {
    // ignore
  }

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
  console.error('[operator-session-stop] error (fail-open):', err);
  process.exit(0);
});
