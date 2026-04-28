#!/usr/bin/env node
/**
 * SessionStart hook: write an agent-session atom for the operator's
 * Claude Code session so the pulse dashboard reflects this session
 * uniformly with autonomous-agent sessions.
 *
 * The substrate already has the agent-session/agent-turn primitive
 * (PR1 #166); the operator's terminal session IS an agent-session
 * (apex-agent acting through Claude Code), so we reuse the existing
 * type rather than bifurcate the substrate with a new one.
 *
 * Idempotent: atom-id is `agent-session-op-<session_id>` so a re-fired
 * SessionStart for the same Claude Code session_id (e.g., on resume)
 * lands on the same atom.
 *
 * Fail-open: any internal error logs to stderr but exits 0 so the
 * hook never wedges Claude Code.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import {
  buildOperatorSessionAtom,
  parseHookPayload,
} from '../../scripts/lib/operator-claude-session.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');

const PRINCIPAL_ID = process.env.LAG_OPERATOR_ID || 'apex-agent';
const ADAPTER_ID = 'claude-code-operator-hook';
/*
 * Best-effort model id. Hooks do not receive the model that the
 * Claude Code CLI is running under; we record the configured default
 * here. Drift from the actual runtime model is acceptable: this field
 * is informational on the dashboard, not load-bearing for arbitration.
 */
const MODEL_ID = process.env.LAG_OPERATOR_MODEL_ID || 'claude-opus-4-7';

async function main() {
  const raw = await readStdin();
  const payload = parseHookPayload(raw);
  if (payload === null) {
    process.exit(0);
  }

  const startedAt = new Date().toISOString();
  const workspaceId = typeof payload.cwd === 'string' && payload.cwd.length > 0
    ? payload.cwd
    : REPO_ROOT;

  const atom = buildOperatorSessionAtom({
    sessionId: payload.session_id,
    principalId: PRINCIPAL_ID,
    startedAt,
    workspaceId,
    modelId: MODEL_ID,
    adapterId: ADAPTER_ID,
  });

  await mkdir(STATE_DIR, { recursive: true });
  const { createFileHost } = await import('../../dist/adapters/file/index.js');
  const host = await createFileHost({ rootDir: STATE_DIR });

  /*
   * Idempotency: if an atom already exists for this session_id, skip
   * the write. Re-firing SessionStart should NOT reset started_at
   * (which would mislead the dashboard's session-age column).
   */
  const existing = await host.atoms.get(atom.id);
  if (existing !== null) {
    process.exit(0);
  }
  await host.atoms.put(atom);
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
  console.error('[operator-session-start] error (fail-open):', err);
  process.exit(0);
});
