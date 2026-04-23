#!/usr/bin/env node
/**
 * Virtual-org bootstrap entry point.
 *
 * Spins up a two-agent deliberation (CTO + Code Author) and, when
 * `--execute` is set, routes the Decision through a real Host +
 * CodeAuthorExecutor to produce a draft PR end-to-end.
 *
 * Runtime wiring:
 *   - Deliberate-only (default): memory-backed Host; no Git / GitHub
 *     side effects.
 *   - Execute mode (`--execute`): file-backed Host (`<state-dir>/`)
 *     with the Claude CLI LLM + App-backed GhClient + default
 *     CodeAuthorExecutor.
 *   - Kill-switch watching `.lag/STOP` in CWD.
 *   - Default LLM messages backend for deliberation: Claude Code CLI
 *     (no API key). `LAG_LLM_BACKEND=sdk` opts into direct Anthropic
 *     SDK so plaintext reasoning blocks surface.
 *
 * CLI flags (executor-only; ignored in deliberate-only mode):
 *   --repo-dir <path>                  (default: cwd)
 *   --owner <name>                     (default: stephengardner)
 *   --repo <name>                      (default: layered-autonomous-governance)
 *   --state-dir <path>                 (default: .lag/virtual-org-state)
 *   --role <lag-ceo|lag-cto|lag-pr-landing>  (default: lag-ceo)
 *   --model <name>                     (default: claude-opus-4-7)
 *
 * Env flags:
 *   LAG_OPERATOR_ID                    operator principal id that should
 *                                      author seeded fence atoms. Defaults
 *                                      to reading the `role: "root"`
 *                                      principal from the seed principals
 *                                      directory.
 *
 * All substrate imports resolve to `../../../dist/` (the compiled
 * output). Run `npm run build` before `node boot.mjs`.
 */

import { resolve, dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync } from 'node:fs';

import { createMemoryHost } from '../../../dist/adapters/memory/index.js';
import { createKillSwitch } from '../../../dist/kill-switch/index.js';
import {
  defaultLlmClient,
  loadCanonFixtures,
  loadSeedPrincipals,
  parseBootArgs,
  parseExecutorArgs,
  runDeliberation,
} from '../../../dist/examples/virtual-org-bootstrap/boot-lib.js';
import {
  buildVirtualOrgHost,
} from '../../../dist/examples/virtual-org-bootstrap/host-builder.js';
import {
  createVirtualOrgLLM,
} from '../../../dist/examples/virtual-org-bootstrap/llm-factory.js';
import {
  createVirtualOrgGhClient,
} from '../../../dist/examples/virtual-org-bootstrap/gh-client-factory.js';
import {
  createVirtualOrgCodeAuthorFn,
} from '../../../dist/examples/virtual-org-bootstrap/executor-factory.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CWD = process.cwd();
const STATE_DIR = resolve(CWD, '.lag');

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(STATE_DIR, { recursive: true });

  // Two-stage argv parse: extract executor-scoped flags first, then
  // defer the remaining argv to parseBootArgs for `--execute` and the
  // positional prompt. Unknown `--*` tokens reach parseBootArgs and
  // trip its fail-fast guard.
  let execCfg;
  let args;
  try {
    const parsed = parseExecutorArgs(process.argv.slice(2), { cwd: CWD });
    execCfg = parsed.known;
    args = parseBootArgs(parsed.rest);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }

  const principalsDir = join(HERE, 'principals');
  const canonDir = join(HERE, 'canon');
  const seeds = loadSeedPrincipals({ dir: principalsDir });
  const canonAtoms = loadCanonFixtures(canonDir);

  const prompt = await readPrompt(args.prompt);
  const question = {
    id: `q-${Date.now()}`,
    type: 'question',
    prompt,
    scope: ['bootstrap'],
    authorPrincipal: 'vo-cto',
    participants: ['vo-cto', 'vo-code-author'],
    roundBudget: 2,
    timeoutAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
  };

  // Default: CLI client (no API key). When LAG_LLM_BACKEND=sdk is set,
  // dynamic-import @anthropic-ai/sdk to avoid pulling it in on the
  // CLI-only path.
  let sdkFactory;
  if (process.env.LAG_LLM_BACKEND === 'sdk') {
    const { Anthropic } = await import('@anthropic-ai/sdk');
    sdkFactory = () => new Anthropic();
  }
  const anthropic = defaultLlmClient(
    sdkFactory !== undefined ? { sdkFactory } : {},
  );

  const participating = seeds.filter(
    (s) => s.principal.id === 'vo-cto' || s.principal.id === 'vo-code-author',
  );

  const killSwitch = createKillSwitch({ stateDir: STATE_DIR });

  // Lifecycle: the file-backed host built via buildVirtualOrgHost
  // exposes a close() seam; the memory-host path has none. Track any
  // resource-holding builder in a list so the finally block tears
  // them down regardless of which branch ran.
  const lifecycle = [];

  try {
    // Build the Host + executor wiring when --execute. The
    // deliberate-only default stays pure memory + no GhClient + no
    // subprocess so an unintentional run remains cheap and reversible.
    let host;
    let codeAuthorFn;
    if (args.execute) {
      const stateDirAbs = isAbsolute(execCfg.stateDir)
        ? execCfg.stateDir
        : resolve(CWD, execCfg.stateDir);
      mkdirSync(stateDirAbs, { recursive: true });

      // Operator principal resolution: LAG_OPERATOR_ID takes precedence
      // so a production deployment can point at its own operator
      // identity without touching source. Fallback is the first
      // `role: "root"` principal discovered in the seed directory; we
      // pass the full Principal record through seedPrincipals so the
      // fence-atom seeder writes against a resolvable author (the
      // runtime validation in buildVirtualOrgHost throws otherwise).
      const operatorSeed = resolveOperatorPrincipal(seeds, process.env.LAG_OPERATOR_ID);
      const built = await buildVirtualOrgHost({
        stateDir: stateDirAbs,
        llm: createVirtualOrgLLM(),
        operatorPrincipalId: operatorSeed.principal.id,
        seedPrincipals: [operatorSeed.principal],
      });
      lifecycle.push(built);
      host = built.host;
      // Seed the participating principals + canon fixtures into the
      // built host so the deliberator sees them (createFileHost
      // starts empty; operator already registered via seedPrincipals).
      for (const seed of participating) await host.principals.put(seed.principal);
      for (const atom of canonAtoms) await host.atoms.put(atom);

      // Credentials + bot identity share the resolved state root so a
      // caller-supplied --state-dir applies uniformly. Splitting them
      // would let the file-backed Host read from `<custom>/.lag/` while
      // the GhClient kept loading credentials from `<cwd>/.lag/apps/*`;
      // single-root keeps both sides of the executor looking at the
      // same on-disk config.
      const ghClient = createVirtualOrgGhClient({
        role: execCfg.role,
        stateDir: stateDirAbs,
      });
      codeAuthorFn = createVirtualOrgCodeAuthorFn({
        host,
        ghClient,
        owner: execCfg.owner,
        repo: execCfg.repo,
        repoDir: execCfg.repoDir,
        gitIdentity: buildBotGitIdentity(execCfg.role, stateDirAbs),
        model: execCfg.model,
      });
    } else {
      host = createMemoryHost();
      for (const seed of participating) await host.principals.put(seed.principal);
      for (const atom of canonAtoms) await host.atoms.put(atom);
    }

    const runArgs = {
      question,
      participants: participating,
      atomStore: host.atoms,
      principalStore: host.principals,
      anthropic,
      canonAtoms,
      decidingPrincipal: 'vo-cto',
      signal: killSwitch.signal,
    };
    if (args.execute) {
      runArgs.execute = true;
      runArgs.executorPrincipalId = 'vo-code-author';
      runArgs.host = host;
      runArgs.codeAuthorFn = codeAuthorFn;
    }
    const result = await runDeliberation(runArgs);
    console.log(JSON.stringify(result, null, 2));
    const typeCounts = await summarizeAtomCounts(host.atoms);
    console.error(`[boot] atoms written by type: ${JSON.stringify(typeCounts)}`);
    if (!args.execute) {
      console.error('[boot] deliberate-only (default): pass --execute to opt into the executor path');
    } else if (result.execution) {
      console.error(`[boot] execution: ${result.execution.kind}`);
    } else {
      console.error('[boot] execution: not triggered (escalation outcome)');
    }
  } finally {
    killSwitch.dispose();
    for (const built of lifecycle) {
      try { await built.close(); } catch { /* ignore */ }
    }
  }
}

function resolveOperatorPrincipal(seeds, envOperatorId) {
  // Env override first so a production deployment can redirect the
  // operator identity without editing source. The override must name a
  // principal that exists in the loaded seeds; an unknown id would
  // stamp fence atoms with a dangling author, and buildVirtualOrgHost's
  // runtime validation would already throw, but failing here keeps the
  // error site close to the CLI surface.
  if (envOperatorId) {
    const match = seeds.find((s) => String(s.principal.id) === envOperatorId);
    if (!match) {
      throw new Error(
        `[boot] LAG_OPERATOR_ID='${envOperatorId}' does not match any seed principal in `
        + `src/examples/virtual-org-bootstrap/principals/. Provision a seed for this id or `
        + `unset the env var to fall back to the role: "root" principal.`,
      );
    }
    return match;
  }
  const root = seeds.find((s) => s.principal.role === 'root');
  if (!root) {
    throw new Error(
      '[boot] no seed principal has role: "root"; set LAG_OPERATOR_ID to the intended operator id.',
    );
  }
  return root;
}

function buildBotGitIdentity(role, stateDir) {
  // Compose the noreply address GitHub minted for this App bot: the
  // appId lives on the on-disk role record. Format:
  //   <appId>+<slug>[bot]@users.noreply.github.com
  const recordPath = join(stateDir, 'apps', `${role}.json`);
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  return {
    name: `${record.slug}[bot]`,
    email: `${record.appId}+${record.slug}[bot]@users.noreply.github.com`,
  };
}

async function readPrompt(fromArgs) {
  if (fromArgs) return fromArgs;
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const combined = Buffer.concat(chunks).toString('utf8').trim();
    if (combined.length > 0) return combined;
  }
  return 'Smoke test: propose a patch-level version bump rationale.';
}

async function summarizeAtomCounts(atomStore) {
  const page = await atomStore.query({}, 10_000);
  const counts = {};
  for (const atom of page.atoms) {
    const kindTag = typeof atom.metadata?.kind === 'string'
      ? `${atom.type}:${atom.metadata.kind}`
      : atom.type;
    counts[kindTag] = (counts[kindTag] ?? 0) + 1;
  }
  return counts;
}

main().catch((err) => {
  console.error('[boot] fatal:', err);
  process.exit(1);
});
