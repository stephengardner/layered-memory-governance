/**
 * bridge adapter conformance.
 *
 * The bridge adapter composes BridgeAtomStore (wraps FileAtomStore + adds
 * bootstrap-from-chroma) with FileCanonStore, FileAuditor,
 * FileNotifier, FilePrincipalStore, FileScheduler, FileClock, and
 * ClaudeCliLLM. Since the wrapping is thin, most of the contract
 * inherits from the file adapter; but "should" is not "does," so we
 * run the parameterized shared specs against a composed BridgeHost to
 * prove it.
 *
 * Gating: this suite does NOT require LAG_REAL_PALACE. The bridge adapter
 * only touches the palace inside `bootstrap()`; conformance exercises
 * put/get/search/etc on an empty host. A nonexistent palacePath is
 * passed at construction.
 *
 * Excluded from the bridge harness:
 *   - embedder-spec (tested directly against TrigramEmbedder /
 *     CachingEmbedder; the bridge adapter just threads the embedder through to
 *     FileAtomStore)
 *   - llm-spec (bridge uses ClaudeCliLLM; llm-spec's register/invalidateNext
 *     are MemoryLLM test helpers)
 *   - clock-spec (bridge uses FileClock, no advance() method)
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeHost } from '../../src/adapters/bridge/index.js';
import type { PrincipalId } from '../../src/substrate/types.js';
import { runAtomsSpec } from './shared/atoms-spec.js';
import { runAuditorSpec } from './shared/auditor-spec.js';
import { runCanonSpec } from './shared/canon-spec.js';
import { runNotifierSpec } from './shared/notifier-spec.js';
import { runPrincipalsSpec } from './shared/principals-spec.js';
import { runSchedulerSpec } from './shared/scheduler-spec.js';

async function makePhxTarget() {
  const rootDir = await mkdtemp(join(tmpdir(), 'lag-bridge-conf-'));
  // palacePath is only consulted inside bootstrap(); conformance never
  // calls bootstrap. A nonexistent path is safe.
  const host = await createBridgeHost({
    palacePath: join(rootDir, 'nonexistent-palace'),
    rootDir,
    defaultPrincipalId: 'bridge-conformance' as PrincipalId,
  });
  return {
    host,
    cleanup: async () => {
      try { await host.cleanup(); } catch { /* ignore */ }
      try { await rm(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

runAtomsSpec('bridge', makePhxTarget);
runCanonSpec('bridge', makePhxTarget);
runPrincipalsSpec('bridge', makePhxTarget);
runNotifierSpec('bridge', makePhxTarget);
runSchedulerSpec('bridge', makePhxTarget);
runAuditorSpec('bridge', makePhxTarget);
