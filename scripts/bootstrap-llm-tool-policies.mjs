#!/usr/bin/env node
/**
 * Canon bootstrap for per-principal LLM tool policies.
 *
 * Implements the forward contract seeded by `dev-actor-scoped-llm-
 * tool-policy` (ratified in PR #77): every LLM-backed actor's
 * `disallowedTools` list is resolved from a canon policy atom
 * `pol-llm-tool-policy-<principal-id>`, not from a framework
 * constant. Default posture per the directive: Read, Grep, and Glob
 * allowed (reads are correctness-load-bearing); Write, Edit,
 * MultiEdit, Bash, WebFetch, WebSearch, and the higher-level
 * delegation/search tools denied because writes route through the
 * existing signed-PR fence.
 *
 * Seeds two policy atoms as the first consumers of the mechanism
 * shipped in PR #75 (`src/llm-tool-policy.ts` loader +
 * `LlmOptions.disallowedTools` threaded through `ClaudeCliLLM`):
 *
 *   pol-llm-tool-policy-cto-actor
 *     Planner posture: Read + Grep + Glob allowed so the CTO can
 *     ground plans in both canon (already readable via atoms) AND
 *     the current code state. Writes + Bash + Web denied; all
 *     planning output is an atom write (handled by the framework,
 *     not the LLM subprocess).
 *
 *   pol-llm-tool-policy-code-author
 *     Executor posture: same reads as planner so draft diffs
 *     ground in current file state. Writes still denied because
 *     the code-author's output channel is signed-PR per fence #1
 *     (`pol-code-author-signed-pr-only`); direct file writes would
 *     bypass the fence. Bash denied at the LLM subprocess layer
 *     because the executor's git operations route through the
 *     runner (`git-ops.ts` in the forthcoming executor PR), not
 *     through subprocess tool calls.
 *
 * The auditor-actor is deliberately left without a policy atom in
 * this revision: the auditor's `runAuditor` function is purely
 * deterministic atom-reads, no LLM call -- the adapter default
 * (deny-all) is correct for it and needs no canon edit.
 *
 * Idempotent per atom id; drift against the stored shape fails
 * loud (same discipline as `bootstrap-dev-canon-proposals.mjs`
 * shipped in #77 with the symmetric metadata-key diff).
 */

import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');
const BOOTSTRAP_TIME = '2026-04-21T17:00:00.000Z';

const OPERATOR_ID = process.env.LAG_OPERATOR_ID;
if (!OPERATOR_ID) {
  console.error(
    '[bootstrap-llm-tool-policies] ERROR: LAG_OPERATOR_ID is not set.\n'
    + '  export LAG_OPERATOR_ID=<your-operator-id>\n',
  );
  process.exit(2);
}

// Deny-list shared by both planner + executor postures. Each entry
// is a tool name the Claude CLI subprocess MUST NOT call. The list
// deliberately omits Read, Grep, and Glob so the LLM can observe
// the repo state when producing grounded plans / diffs; it includes
// Write, Edit, MultiEdit, Bash, WebFetch, WebSearch, Task, Agent,
// NotebookEdit, TodoWrite, and SlashCommand which would either
// bypass the signed-PR fence or escape the actor's authority
// envelope.
const READ_ONLY_DENY = [
  'Bash',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'TodoWrite',
  'SlashCommand',
];

const POLICIES = [
  {
    principalId: 'cto-actor',
    rationale:
      'CTO planner posture: Read + Grep + Glob allowed so plans ground in both canon and '
      + 'current code state. Writes + Bash + Web* denied; all planning output is an atom '
      + 'write handled by framework code, not the LLM subprocess. Derived from '
      + 'dev-actor-scoped-llm-tool-policy (PR #77).',
  },
  {
    principalId: 'code-author',
    rationale:
      'Code-author executor posture: same reads as planner so drafted diffs ground in '
      + 'current file state. Writes denied because the code-author output channel is '
      + 'signed-PR per pol-code-author-signed-pr-only; direct file writes bypass the '
      + 'fence. Bash denied at LLM layer because git operations route through the runner, '
      + 'not subprocess tool calls. Derived from dev-actor-scoped-llm-tool-policy + '
      + 'pol-code-author-signed-pr-only.',
  },
];

function atomFromSpec(spec) {
  return {
    schema_version: 1,
    id: `pol-llm-tool-policy-${spec.principalId}`,
    content:
      `LLM tool deny-list for principal "${spec.principalId}". `
      + `Blocks: ${READ_ONLY_DENY.join(', ')}. `
      + 'Read, Grep, and Glob are allowed by omission. '
      + spec.rationale,
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'bootstrap-llm-tool-policies', agent_id: 'bootstrap' },
      derived_from: [
        'dev-actor-scoped-llm-tool-policy',
        'dev-canon-is-strategic-not-tactical',
        'inv-provenance-every-write',
        'dev-indie-floor-org-ceiling',
      ],
    },
    confidence: 1.0,
    created_at: BOOTSTRAP_TIME,
    last_reinforced_at: BOOTSTRAP_TIME,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: OPERATOR_ID,
    taint: 'clean',
    metadata: {
      policy: {
        subject: 'llm-tool-policy',
        principal: spec.principalId,
        disallowed_tools: [...READ_ONLY_DENY],
        rationale: spec.rationale,
      },
    },
  };
}

// Drift-check pattern mirrors bootstrap-dev-canon-proposals.mjs's
// symmetric key diff (fixed per CR on #77): walks the union of
// stored + expected metadata keys so a stale legacy key on either
// side surfaces as drift rather than silently passing.
function diffAtom(existing, expected) {
  const diffs = [];
  for (const k of ['type', 'layer', 'content', 'principal_id', 'taint']) {
    if (existing[k] !== expected[k]) {
      diffs.push(`${k}: stored=${JSON.stringify(existing[k])} expected=${JSON.stringify(expected[k])}`);
    }
  }
  const em = existing.metadata ?? {};
  const xm = expected.metadata;
  const allKeys = new Set([...Object.keys(xm), ...Object.keys(em)]);
  for (const k of allKeys) {
    if (JSON.stringify(em[k]) !== JSON.stringify(xm[k])) {
      diffs.push(`metadata.${k}: stored vs expected differ`);
    }
  }
  if (existing.provenance?.kind !== expected.provenance.kind) {
    diffs.push(
      `provenance.kind: stored=${JSON.stringify(existing.provenance?.kind)} `
      + `expected=${JSON.stringify(expected.provenance.kind)}`,
    );
  }
  if (JSON.stringify(existing.provenance?.source ?? null) !== JSON.stringify(expected.provenance.source)) {
    diffs.push('provenance.source differs');
  }
  if (JSON.stringify(existing.provenance?.derived_from ?? []) !== JSON.stringify(expected.provenance.derived_from)) {
    diffs.push('provenance.derived_from differs');
  }
  return diffs;
}

async function main() {
  await mkdir(STATE_DIR, { recursive: true });
  const host = await createFileHost({ rootDir: STATE_DIR });
  let written = 0;
  let ok = 0;
  for (const spec of POLICIES) {
    const expected = atomFromSpec(spec);
    const existing = await host.atoms.get(expected.id);
    if (existing === null) {
      await host.atoms.put(expected);
      written += 1;
      console.log(`[bootstrap-llm-tool-policies] wrote ${expected.id}`);
      continue;
    }
    const diffs = diffAtom(existing, expected);
    if (diffs.length > 0) {
      console.error(`[bootstrap-llm-tool-policies] DRIFT on ${expected.id}:\n  ${diffs.join('\n  ')}`);
      process.exitCode = 1;
      return;
    }
    ok += 1;
  }
  console.log(`[bootstrap-llm-tool-policies] done. ${written} written, ${ok} already in sync.`);
}

await main();
