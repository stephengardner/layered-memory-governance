# Autonomous-intent substrate implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `operator-intent` atom, `intend` CLI, CTO schema + writer extension for delegation, new `runIntentAutoApprovePass` tick, code-author dispatch invoker, auditor with `LAG-auditor` GitHub status check, and required branch-protection migration - so that CTO-authored plans derived from a fresh operator-intent atom propagate proposed -> approved -> executing -> succeeded with zero operator touch.

**Architecture:** Intent atom is L1 operator-authored declarative input carrying a `trust_envelope`. CTO's `PLAN_DRAFT` schema gains a required `delegation` field. Planner writes intent id into `provenance.derived_from`. New tick reads the intent via provenance walk, checks envelope, transitions to approved. Existing dispatch tick invokes `code-author`; auditor runs post-PR-open writing `LAG-auditor` GitHub status; reconcile tick closes the plan on PR merge.

**Tech stack:** Node >=22 ES modules, vitest, zod (existing), execa, plain git + gh. No new runtime deps.

**Working branch:** `feat/autonomous-intent-substrate` in `.worktrees/autonomous-intent-substrate/`. Spec: `docs/superpowers/specs/2026-04-24-autonomous-intent-substrate-design.md`.

**Out of scope (from spec):**
- No L3 canon automation (intent cannot authorize canon-write-l3).
- No bot-authored intents (v1: operator-principal-only).
- No multi-reviewer bot deliberation.
- No retroactive migration of 18 stuck plans.
- No changes to existing code-author Question→PR direct pipeline.
- No changes to CR / CI gate mechanics.

---

## File structure

**Create (14 new files):**

- `src/substrate/types.ts` (modify)  -  add `OperatorIntent` type to the `Atom` union.
- `scripts/lib/intend.mjs`  -  pure helpers for intend CLI (arg parsing, atom construction, envelope defaults).
- `scripts/intend.mjs`  -  CLI entry (dispatcher over `scripts/lib/intend.mjs`).
- `test/scripts/intend.test.ts`  -  unit tests for intend helpers.
- `src/runtime/actor-message/intent-approve.ts`  -  `runIntentAutoApprovePass` + pure helpers (`RADIUS_RANK`, `findIntentInProvenance`).
- `test/runtime/actor-message/intent-approve.test.ts`  -  unit tests for the tick.
- `scripts/invokers/autonomous-dispatch.mjs`  -  registers code-author invoker for run-approval-cycle.
- `scripts/lib/auditor.mjs`  -  pure helpers for auditor (diff-scope classifier, verdict computation).
- `scripts/run-auditor.mjs`  -  CLI that runs the auditor (invoked from pr-landing workflow).
- `test/scripts/auditor.test.ts`  -  unit tests for auditor helpers.
- `scripts/migrations/2026-04-24-add-lag-auditor-status-check.mjs`  -  idempotent branch-protection migration.
- `scripts/bootstrap-autonomous-intent-canon.mjs`  -  canon atom bootstrap for the 3 new atoms.
- `.claude/skills/autonomous-intent/SKILL.md`  -  skill docs.
- `test/integration/autonomous-intent-e2e.test.ts`  -  gated integration test.

**Modify (6 files):**

- `src/schemas/index.ts`  -  add `delegation` field to `planDraftOutput`; update PLAN_DRAFT systemPrompt.
- `src/runtime/actors/planning/planning-actor.ts`  -  write `delegation` into metadata; append intent id to `provenance.derived_from`.
- `src/runtime/actor-message/index.ts`  -  export `runIntentAutoApprovePass`.
- `scripts/run-approval-cycle.mjs`  -  wire intent tick as tick 0.
- `scripts/run-cto-actor.mjs`  -  accept `--intent-id` flag; thread through to planner.
- `.github/workflows/pr-landing.yml`  -  auditor invocation step gated on `plan-id:` label.
- `package.json`  -  add `"intend": "node scripts/intend.mjs"` npm script.

**Do NOT modify:**
- Anything in `memory-governance-apps` or `memory-governance-substrate` sibling worktrees.
- `apps/console/**` (timeline UI improvements are a separate PR).
- Auto-managed canon block in main `CLAUDE.md`.
- Existing code-author Question→PR pipeline code paths.

---

## Task 1: Skill file

**Files:**
- Create: `.claude/skills/autonomous-intent/SKILL.md`

- [ ] **Step 1: Read reference skill**

Read `C:/Users/opens/memory-governance/.claude/skills/cto-actor/SKILL.md` to match tone and structure (Composition diagram + Run paths + Authority table + Consult-before-changing).

- [ ] **Step 2: Write the skill**

Sections in order:
1. Frontmatter: `name: autonomous-intent`, `description: Use when the operator wants a problem solved autonomously through the plan-approval pipeline: from operator-intent atom -> CTO plan -> auto-approval -> code-author dispatch -> auditor pre-flight -> PR merge -> plan-state reconcile.`
2. Overview (2-3 sentences).
3. The intent CLI surface (`node scripts/intend.mjs ...`) with every flag explained.
4. The trust envelope fields: `max_blast_radius`, `allowed_sub_actors`, `min_plan_confidence`, `require_ci_green`, `require_cr_approve`, `require_auditor_observation`, `expires_at` (default 24h, capped 72h).
5. What happens after `intend`: CTO drafts plan(s) with delegation; approval tick auto-approves if envelope matches; dispatch invokes code-author; auditor runs; PR lands; reconcile closes the plan.
6. When NOT to use this skill: L3 canon edits (human-only), experiments needing observation-only audit (`auditor-actor` target suffices; no intent needed), urgent fixes the operator will merge manually.
7. Kill-switch: `.lag/STOP` halts at the top of every tick.
8. Failure modes: expired intent, compromised principal, confidence below threshold, blast-radius over envelope, auditor verdict=fail. Each is a documented escalation path.
9. Integration with other skills: `cto-actor` (downstream when intent triggers a CTO run), `pr-landing-agent` (downstream when code-author opens the PR).

Keep under 200 lines. Zero emdashes.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/autonomous-intent/SKILL.md
git commit -m "skill: add autonomous-intent skill for operator-driven autonomous solve"
```

---

## Task 2: `OperatorIntent` atom type

**Files:**
- Modify: `src/substrate/types.ts`

- [ ] **Step 1: Read existing type definitions**

Read `src/substrate/types.ts` to find `Atom` discriminated union and related type helpers.

- [ ] **Step 2: Add `OperatorIntent` to the union**

Find the `AtomType` union definition in `src/substrate/types.ts`. The current union is broader than the illustrative list here; it includes values like `ephemeral`, `actor-message`, `plan-approval-vote`, and others. **APPEND** `'operator-intent'` to the existing union. DO NOT rewrite or shrink the union to match this plan's examples.

```bash
grep -n "AtomType\b" src/substrate/types.ts
```

Then append the new tag:

```ts
// Existing (do NOT replace; only append):
// export type AtomType = 'directive' | 'decision' | 'preference' | 'reference'
//   | 'plan' | 'observation' | 'question' | 'ephemeral' | 'actor-message'
//   | 'plan-approval-vote' | ... ;

// Add:
//   | 'operator-intent';
```

- [ ] **Step 3: Run typecheck**

```bash
cd .worktrees/autonomous-intent-substrate && npm run typecheck 2>&1 | tail -20
```

Expected: no new errors; any existing errors pre-date this change.

- [ ] **Step 4: Commit**

```bash
git add src/substrate/types.ts
git commit -m "substrate/types: add operator-intent to AtomType union"
```

---

## Task 3: `intend` CLI helpers (TDD)

**Files:**
- Create: `scripts/lib/intend.mjs`
- Create: `test/scripts/intend.test.ts`

- [ ] **Step 1: Write failing tests for `parseIntendArgs`**

```typescript
// test/scripts/intend.test.ts
import { describe, expect, it } from 'vitest';
import { parseIntendArgs, buildIntentAtom, computeExpiresAt } from '../../scripts/lib/intend.mjs';

describe('parseIntendArgs', () => {
  it('parses required --request + --scope + --blast-radius', () => {
    const r = parseIntendArgs([
      '--request', 'fix the CTO',
      '--scope', 'tooling',
      '--blast-radius', 'framework',
      '--sub-actors', 'code-author',
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.request).toBe('fix the CTO');
    expect(r.args.scope).toBe('tooling');
    expect(r.args.blastRadius).toBe('framework');
    expect(r.args.subActors).toEqual(['code-author']);
  });

  it('accepts multiple --sub-actors values (comma or repeated)', () => {
    const r = parseIntendArgs(['--request', 'x', '--scope', 't', '--blast-radius', 'tooling', '--sub-actors', 'code-author,auditor-actor']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.subActors).toEqual(['code-author', 'auditor-actor']);
  });

  it('rejects invalid blast-radius', () => {
    const r = parseIntendArgs(['--request', 'x', '--scope', 't', '--blast-radius', 'everything', '--sub-actors', 'code-author']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/blast-radius/i);
  });

  it('rejects missing --request', () => {
    const r = parseIntendArgs(['--scope', 't', '--blast-radius', 'tooling', '--sub-actors', 'code-author']);
    expect(r.ok).toBe(false);
  });

  it('accepts optional --expires-in', () => {
    const r = parseIntendArgs(['--request', 'x', '--scope', 't', '--blast-radius', 'tooling', '--sub-actors', 'code-author', '--expires-in', '6h']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.expiresIn).toBe('6h');
  });

  it('accepts --dry-run flag', () => {
    const r = parseIntendArgs(['--request', 'x', '--scope', 't', '--blast-radius', 'tooling', '--sub-actors', 'code-author', '--dry-run']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.dryRun).toBe(true);
  });
});

describe('computeExpiresAt', () => {
  const now = new Date('2026-04-24T12:00:00Z');
  it('defaults to +24h when unset', () => {
    expect(computeExpiresAt(undefined, now)).toBe('2026-04-25T12:00:00.000Z');
  });
  it('accepts 6h', () => {
    expect(computeExpiresAt('6h', now)).toBe('2026-04-24T18:00:00.000Z');
  });
  it('accepts 30m', () => {
    expect(computeExpiresAt('30m', now)).toBe('2026-04-24T12:30:00.000Z');
  });
  it('rejects over 72h (safety cap)', () => {
    expect(() => computeExpiresAt('73h', now)).toThrow(/72/);
  });
  it('rejects invalid format', () => {
    expect(() => computeExpiresAt('tomorrow', now)).toThrow();
  });
});

describe('buildIntentAtom', () => {
  it('constructs a well-formed atom from validated args', () => {
    const atom = buildIntentAtom({
      request: 'fix X',
      scope: 'tooling',
      blastRadius: 'framework',
      subActors: ['code-author'],
      minConfidence: 0.75,
      expiresAt: '2026-04-25T12:00:00.000Z',
      operatorPrincipalId: 'operator-principal',
      now: new Date('2026-04-24T12:00:00Z'),
      nonce: 'abc123',
    });
    expect(atom.type).toBe('operator-intent');
    expect(atom.layer).toBe('L1');
    expect(atom.principal_id).toBe('operator-principal');
    expect(atom.id.startsWith('intent-')).toBe(true);
    expect(atom.metadata.kind).toBe('autonomous-solve');
    expect(atom.metadata.trust_envelope.max_blast_radius).toBe('framework');
    expect(atom.metadata.trust_envelope.allowed_sub_actors).toEqual(['code-author']);
    expect(atom.metadata.trust_envelope.min_plan_confidence).toBe(0.75);
    expect(atom.metadata.trust_envelope.require_ci_green).toBe(true);
    expect(atom.metadata.trust_envelope.require_cr_approve).toBe(true);
    expect(atom.metadata.trust_envelope.require_auditor_observation).toBe(true);
    expect(atom.metadata.expires_at).toBe('2026-04-25T12:00:00.000Z');
    expect(atom.provenance.kind).toBe('operator-seeded');
    expect(atom.confidence).toBe(1);
    expect(atom.taint).toBe('clean');
  });
});
```

- [ ] **Step 2: Run tests; verify failure**

```bash
npx vitest run test/scripts/intend.test.ts 2>&1 | tail -15
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `scripts/lib/intend.mjs`**

```javascript
// scripts/lib/intend.mjs - pure helpers for scripts/intend.mjs.
// Zero imports from src/, dist/, .lag/ beyond the shared Atom type.

const SCOPE_VALUES = ['tooling', 'docs', 'framework', 'canon'];
const BLAST_RADIUS_VALUES = ['none', 'docs', 'tooling', 'framework', 'l3-canon-proposal'];
const SUB_ACTORS = ['code-author', 'auditor-actor'];

export function parseIntendArgs(argv) {
  const args = {
    request: null,
    scope: null,
    blastRadius: null,
    subActors: null,
    minConfidence: 0.75,
    expiresIn: undefined,
    kind: 'autonomous-solve',
    dryRun: false,
    trigger: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--request' && i + 1 < argv.length) { args.request = argv[++i]; }
    else if (a === '--scope' && i + 1 < argv.length) { args.scope = argv[++i]; }
    else if (a === '--blast-radius' && i + 1 < argv.length) { args.blastRadius = argv[++i]; }
    else if (a === '--sub-actors' && i + 1 < argv.length) { args.subActors = argv[++i].split(',').map(s => s.trim()).filter(Boolean); }
    else if (a === '--min-confidence' && i + 1 < argv.length) { args.minConfidence = Number(argv[++i]); }
    else if (a === '--expires-in' && i + 1 < argv.length) { args.expiresIn = argv[++i]; }
    else if (a === '--kind' && i + 1 < argv.length) { args.kind = argv[++i]; }
    else if (a === '--dry-run') { args.dryRun = true; }
    else if (a === '--trigger') { args.trigger = true; }
    else { return { ok: false, reason: `unknown or misplaced argument: ${a}` }; }
  }
  if (!args.request) return { ok: false, reason: '--request is required' };
  if (!args.scope) return { ok: false, reason: '--scope is required' };
  if (!SCOPE_VALUES.includes(args.scope)) return { ok: false, reason: `--scope must be one of ${SCOPE_VALUES.join(',')}` };
  if (!args.blastRadius) return { ok: false, reason: '--blast-radius is required' };
  if (!BLAST_RADIUS_VALUES.includes(args.blastRadius)) return { ok: false, reason: `--blast-radius must be one of ${BLAST_RADIUS_VALUES.join(',')}` };
  if (!args.subActors || args.subActors.length === 0) return { ok: false, reason: '--sub-actors is required' };
  for (const s of args.subActors) {
    if (!SUB_ACTORS.includes(s)) return { ok: false, reason: `sub-actor ${s} not in v1 allowlist ${SUB_ACTORS.join(',')}` };
  }
  if (!Number.isFinite(args.minConfidence) || args.minConfidence < 0 || args.minConfidence > 1) {
    return { ok: false, reason: '--min-confidence must be a number in [0,1]' };
  }
  return { ok: true, args };
}

const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;
const MAX_EXPIRES_HOURS = 72;

export function computeExpiresAt(raw, now) {
  if (raw === undefined || raw === null) {
    return new Date(now.getTime() + 24 * HOUR_MS).toISOString();
  }
  const m = /^(\d+)([hm])$/.exec(raw);
  if (!m) throw new Error(`invalid --expires-in format: ${raw} (expected Nh or Nm)`);
  const n = Number(m[1]);
  const unit = m[2];
  const totalMs = unit === 'h' ? n * HOUR_MS : n * MIN_MS;
  if (totalMs > MAX_EXPIRES_HOURS * HOUR_MS) {
    throw new Error(`--expires-in exceeds safety cap of ${MAX_EXPIRES_HOURS}h`);
  }
  return new Date(now.getTime() + totalMs).toISOString();
}

export function buildIntentAtom(spec) {
  const {
    request, scope, blastRadius, subActors, minConfidence,
    expiresAt, operatorPrincipalId, now, nonce,
  } = spec;
  const createdAt = now.toISOString();
  const idCore = `intent-${nonce}-${createdAt.replace(/[:.]/g, '-')}`;
  return {
    schema_version: 1,
    id: idCore,
    type: 'operator-intent',
    layer: 'L1',
    principal_id: operatorPrincipalId,
    provenance: {
      kind: 'operator-seeded',
      source: { tool: 'intend-cli' },
      derived_from: [],
    },
    confidence: 1,
    scope,
    content: request,
    metadata: {
      kind: 'autonomous-solve',
      request,
      trust_envelope: {
        max_blast_radius: blastRadius,
        max_plans: 5,
        min_plan_confidence: minConfidence,
        allowed_sub_actors: subActors,
        require_ci_green: true,
        require_cr_approve: true,
        require_auditor_observation: true,
      },
      expires_at: expiresAt,
      consumed_by_plans: [],
      consumed_by_questions: [],
    },
    created_at: createdAt,
    last_reinforced_at: createdAt,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    taint: 'clean',
    signals: { agrees_with: [], disagrees_with: [], refined_by: [] },
  };
}
```

- [ ] **Step 4: Run tests; verify pass**

```bash
npx vitest run test/scripts/intend.test.ts 2>&1 | tail -10
```

Expected: all tests pass (expect ~12 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/intend.mjs test/scripts/intend.test.ts
git commit -m "intend: pure helpers (parse args, compute expires_at, build atom) + tests"
```

---

## Task 4: `intend.mjs` CLI entry

**Files:**
- Create: `scripts/intend.mjs`

- [ ] **Step 1: Implement the CLI**

```javascript
#!/usr/bin/env node
/**
 * intend: CLI for the operator to declare autonomous-solve intent.
 * Writes an operator-intent atom through the file-backed host;
 * optionally seeds a question + invokes CTO via --trigger.
 *
 * Zero imports from src/. Uses dist/adapters/file.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createFileHost } from '../dist/adapters/file/index.js';
import { parseIntendArgs, computeExpiresAt, buildIntentAtom } from './lib/intend.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');

async function main() {
  const parsed = parseIntendArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`[intend] ${parsed.reason}`);
    console.error('usage: node scripts/intend.mjs --request "<text>" --scope <tooling|docs|framework|canon> --blast-radius <none|docs|tooling|framework|l3-canon-proposal> --sub-actors <code-author[,auditor-actor]> [--min-confidence 0.75] [--expires-in 24h] [--dry-run] [--trigger]');
    process.exit(2);
  }
  const args = parsed.args;
  if (existsSync(resolve(STATE_DIR, 'STOP'))) {
    console.error('[intend] .lag/STOP present; kill-switch is armed. Remove it to proceed.');
    process.exit(3);
  }
  const operatorPrincipalId = process.env.LAG_OPERATOR_ID;
  if (!operatorPrincipalId) {
    console.error('[intend] LAG_OPERATOR_ID is not set. Export the operator principal id first.');
    process.exit(2);
  }
  const now = new Date();
  const expiresAt = computeExpiresAt(args.expiresIn, now);
  const nonce = randomBytes(6).toString('hex');
  const atom = buildIntentAtom({
    request: args.request,
    scope: args.scope,
    blastRadius: args.blastRadius,
    subActors: args.subActors,
    minConfidence: args.minConfidence,
    expiresAt,
    operatorPrincipalId,
    now,
    nonce,
  });

  if (args.dryRun) {
    console.log('[intend] --dry-run; would write:');
    console.log(JSON.stringify(atom, null, 2));
    process.exit(0);
  }

  const host = await createFileHost({ rootDir: STATE_DIR });
  await host.atoms.put(atom);
  console.log(`[intend] wrote ${atom.id} (expires ${expiresAt})`);

  if (args.trigger) {
    console.log(`[intend] triggering CTO with intent id: ${atom.id}`);
    const child = spawn('node', [
      resolve(REPO_ROOT, 'scripts/run-cto-actor.mjs'),
      '--request', args.request,
      '--intent-id', atom.id,
    ], { stdio: 'inherit' });
    await new Promise((r) => child.on('exit', (code) => r(code ?? 0)));
  } else {
    console.log(`[intend] no --trigger; invoke manually:\n  node scripts/run-cto-actor.mjs --request "${args.request}" --intent-id ${atom.id}`);
  }
}

main().catch((err) => {
  console.error(`[intend] ${err.message}`);
  process.exit(1);
});
```

- [ ] **Step 2: Smoke test with --dry-run**

```bash
cd .worktrees/autonomous-intent-substrate && LAG_OPERATOR_ID=operator-principal node scripts/intend.mjs --request "smoke" --scope tooling --blast-radius tooling --sub-actors code-author --dry-run 2>&1 | head -20
```

Expected: prints atom JSON, exit 0.

Also test fail-closed:
```bash
unset LAG_OPERATOR_ID; node scripts/intend.mjs --request smoke --scope tooling --blast-radius tooling --sub-actors code-author --dry-run 2>&1 | tail -3
```

Expected: "LAG_OPERATOR_ID is not set"; exit 2.

- [ ] **Step 3: Commit**

```bash
git add scripts/intend.mjs
git commit -m "intend: CLI entry with kill-switch gate, operator-id check, --dry-run, --trigger"
```

---

## Task 5: Extend `planDraftOutput` schema with `delegation` (TDD)

**Files:**
- Modify: `src/schemas/index.ts`
- Create: `test/schemas/plan-draft.test.ts` (if not exists; otherwise extend)

- [ ] **Step 1: Write failing tests**

```typescript
// test/schemas/plan-draft.test.ts
import { describe, expect, it } from 'vitest';
import { PLAN_DRAFT } from '../../src/schemas/index.js';

const valid = {
  title: 'Fix X',
  body: 'Detailed body.',
  derived_from: ['dev-canon-is-strategic-not-tactical'],
  principles_applied: ['dev-right-over-easy-for-external-actions'],
  alternatives_rejected: [],
  what_breaks_if_revisit: 'Sound at 3 months: simple surface.',
  confidence: 0.8,
  delegation: {
    sub_actor_principal_id: 'code-author',
    reason: 'Change requires PR to src/schemas.',
    implied_blast_radius: 'framework',
  },
};

describe('PLAN_DRAFT schema', () => {
  it('accepts a well-formed plan with delegation', () => {
    const res = PLAN_DRAFT.zodSchema.safeParse({ plans: [valid] });
    expect(res.success).toBe(true);
  });
  it('rejects when delegation is missing', () => {
    const { delegation, ...withoutDelegation } = valid;
    const res = PLAN_DRAFT.zodSchema.safeParse({ plans: [withoutDelegation] });
    expect(res.success).toBe(false);
  });
  it('rejects when sub_actor_principal_id is not in v1 allowlist', () => {
    const res = PLAN_DRAFT.zodSchema.safeParse({
      plans: [{ ...valid, delegation: { ...valid.delegation, sub_actor_principal_id: 'deploy-actor' } }],
    });
    expect(res.success).toBe(false);
  });
  it('rejects when implied_blast_radius is invalid', () => {
    const res = PLAN_DRAFT.zodSchema.safeParse({
      plans: [{ ...valid, delegation: { ...valid.delegation, implied_blast_radius: 'everything' } }],
    });
    expect(res.success).toBe(false);
  });
  it('rejects when reason is empty', () => {
    const res = PLAN_DRAFT.zodSchema.safeParse({
      plans: [{ ...valid, delegation: { ...valid.delegation, reason: '' } }],
    });
    expect(res.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests; verify failure**

```bash
npx vitest run test/schemas/plan-draft.test.ts 2>&1 | tail -10
```

Expected: tests fail (schema currently accepts plans without delegation).

- [ ] **Step 3: Extend the schema**

In `src/schemas/index.ts`, find `const planDraftOutput = z.object({ plans: z.array(z.object({ ... })) ... })` and add the delegation field:

```typescript
delegation: z.object({
  sub_actor_principal_id: z.enum(['code-author', 'auditor-actor']),
  reason: z.string().min(1).max(300),
  implied_blast_radius: z.enum(['none', 'docs', 'tooling', 'framework', 'l3-canon-proposal']),
}),
```

Also update the corresponding `jsonSchema` for the same new required key `delegation` (inspection of existing code: the JSON schema mirror is required for LLM structured-output mode).

- [ ] **Step 4: Update the systemPrompt**

Find `PLAN_DRAFT.systemPrompt` and append a new section before the closing instruction:

```
DELEGATION:
- You MUST include a "delegation" object on every plan: { sub_actor_principal_id, reason, implied_blast_radius }.
- sub_actor_principal_id: 'code-author' when the plan REQUIRES code changes that open a PR (src/, scripts/, tests/, docs/, config edits). 'auditor-actor' when the plan is a read-only audit or review that writes observation atoms WITHOUT opening a PR.
- reason: one sentence justifying the sub-actor choice; it must make sense in isolation (arbitration-visible).
- implied_blast_radius: 'none' for read-only audits, 'docs' for markdown/asset-only edits, 'tooling' for scripts/config only, 'framework' for src/ edits, 'l3-canon-proposal' when the plan PROPOSES an L3 canon edit that still requires human ratification. Choose the LEAST-permissive radius that accurately describes the change.
- If a request naturally needs BOTH an audit AND a fix, emit TWO plans: one with sub_actor_principal_id='auditor-actor' first, then one with 'code-author' that derives_from the first plan's atom id.
```

- [ ] **Step 5: Run tests; verify pass + no regressions**

```bash
npx vitest run test/schemas 2>&1 | tail -10
```

Expected: 5 new tests pass, prior schema tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/schemas/index.ts test/schemas/plan-draft.test.ts
git commit -m "schemas: add delegation field to planDraftOutput + PLAN_DRAFT prompt guidance"
```

---

## Task 6: Planning-actor writer extension (TDD)

**Files:**
- Modify: `src/runtime/actors/planning/planning-actor.ts`
- Create or modify: `test/runtime/actors/planning/delegation.test.ts`

**Scope note:** `src/runtime/actors/planning/planning-actor.ts` already exposes a helper `buildDelegationMetadata(delegateTo: PrincipalId)` (~line 167; verify via grep). The minimum change is to extend THAT helper to accept the full delegation draft (`{ sub_actor_principal_id, reason, implied_blast_radius }`) and propagate all three fields into `metadata.delegation`. Do NOT extract a new `buildPlanAtom` unless the existing helper makes the edit awkward; prefer tight incremental edits.

- [ ] **Step 1: Locate `buildDelegationMetadata` + atom-construction site**

```bash
grep -n 'buildDelegationMetadata\|delegation\|provenance' src/runtime/actors/planning/planning-actor.ts | head -20
```

Read the helper's signature + the plan-atom write site. Capture line numbers.

- [ ] **Step 2: Write a failing test**

```typescript
// test/runtime/actors/planning/delegation.test.ts
import { describe, expect, it } from 'vitest';
import { buildPlanAtom } from '../../../../src/runtime/actors/planning/planning-actor.js';
// If not exported, extract the builder into a pure helper and export it.

describe('buildPlanAtom (planning-actor)', () => {
  const baseDraft = {
    title: 'Fix',
    body: '...',
    derived_from: ['canon-id-1'],
    principles_applied: [],
    alternatives_rejected: [],
    what_breaks_if_revisit: '...',
    confidence: 0.8,
    delegation: {
      sub_actor_principal_id: 'code-author' as const,
      reason: 'Touches src/',
      implied_blast_radius: 'framework' as const,
    },
  };

  it('writes delegation into plan.metadata.delegation', () => {
    const atom = buildPlanAtom({
      draft: baseDraft,
      principalId: 'cto-actor',
      intentId: null,
      now: new Date('2026-04-24T12:00:00Z'),
      nonce: 'abc',
    });
    expect(atom.metadata.delegation).toEqual(baseDraft.delegation);
  });

  it('appends intent id to provenance.derived_from when provided', () => {
    const atom = buildPlanAtom({
      draft: baseDraft,
      principalId: 'cto-actor',
      intentId: 'intent-xyz-2026-04-24T12-00-00-000Z',
      now: new Date('2026-04-24T12:00:00Z'),
      nonce: 'abc',
    });
    expect(atom.provenance.derived_from).toContain('intent-xyz-2026-04-24T12-00-00-000Z');
    expect(atom.provenance.derived_from).toContain('canon-id-1');
  });

  it('does not add intent id when intentId is null', () => {
    const atom = buildPlanAtom({
      draft: baseDraft,
      principalId: 'cto-actor',
      intentId: null,
      now: new Date('2026-04-24T12:00:00Z'),
      nonce: 'abc',
    });
    expect(atom.provenance.derived_from.every((id: string) => !id.startsWith('intent-'))).toBe(true);
  });
});
```

- [ ] **Step 3: Run; verify failure**

If `buildPlanAtom` isn't exported, the import fails  -  go to step 4 first to extract the builder.

```bash
npx vitest run test/runtime/actors/planning/delegation.test.ts 2>&1 | tail -10
```

- [ ] **Step 4: Extract `buildPlanAtom` into a pure helper**

If the existing code inlines the atom-construction in a larger async flow, refactor it into a standalone exported function `buildPlanAtom(args)` that takes `{ draft, principalId, intentId, now, nonce }` and returns the atom. Keep the signature pure (no I/O). This preserves testability and is the only refactor the task allows.

If `buildPlanAtom` already exists, just extend it.

The implementation MUST:
1. Copy `draft.delegation` into `atom.metadata.delegation`.
2. Append `intentId` to `atom.provenance.derived_from` when `intentId !== null`.
3. Preserve all existing metadata/provenance behaviour.

- [ ] **Step 5: Run; verify pass**

```bash
npx vitest run test/runtime/actors/planning 2>&1 | tail -10
```

Expected: all tests pass, no regressions in other planning tests.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/actors/planning/planning-actor.ts test/runtime/actors/planning/delegation.test.ts
git commit -m "planning-actor: propagate delegation + intent id (provenance chain) into plan atom"
```

---

## Task 7: `run-cto-actor.mjs` --intent-id flag

**Files:**
- Modify: `scripts/run-cto-actor.mjs`

- [ ] **Step 1: Locate arg parsing in the script**

Read `scripts/run-cto-actor.mjs` to find the argv parsing block (after `parseArgs` or manual loop).

- [ ] **Step 2: Add `--intent-id` flag**

Add:
```javascript
else if (a === '--intent-id' && i + 1 < argv.length) { args.intentId = argv[++i]; }
```

Plumb `args.intentId` through to `runPlanningActor(host, { request, intentId, ... })`. Inside the planning-actor, pass it to `buildPlanAtom`. If the planning-actor doesn't currently take this argument, add it to the options object (non-breaking; default null).

- [ ] **Step 3: Smoke test (no LLM cost  -  use --stub if possible)**

```bash
cd .worktrees/autonomous-intent-substrate && LAG_OPERATOR_ID=operator-principal node scripts/run-cto-actor.mjs --stub --request "fix X" --intent-id intent-smoke-test 2>&1 | tail -20
```

Expected: CTO runs under stub, emits a plan whose `provenance.derived_from` includes `intent-smoke-test`. Verify via:
```bash
grep -l "intent-smoke-test" .lag/atoms/**/*.json 2>/dev/null | head
```

- [ ] **Step 4: Commit**

```bash
git add scripts/run-cto-actor.mjs src/runtime/actors/planning/planning-actor.ts
git commit -m "run-cto-actor: accept --intent-id and thread into plan provenance"
```

---

## Task 8: RADIUS_RANK + findIntentInProvenance helpers (TDD)

**Files:**
- Create: `src/runtime/actor-message/intent-approve.ts`
- Create: `test/runtime/actor-message/intent-approve.test.ts`

- [ ] **Step 1: Write failing tests for helpers**

```typescript
// test/runtime/actor-message/intent-approve.test.ts
import { describe, expect, it } from 'vitest';
import { RADIUS_RANK, isBlastRadiusWithin, findIntentInProvenance } from '../../../src/runtime/actor-message/intent-approve.js';

describe('RADIUS_RANK', () => {
  it('orders radius labels ordinally', () => {
    expect(RADIUS_RANK.none).toBe(0);
    expect(RADIUS_RANK.docs).toBeLessThan(RADIUS_RANK.tooling);
    expect(RADIUS_RANK.tooling).toBeLessThan(RADIUS_RANK.framework);
    expect(RADIUS_RANK.framework).toBeLessThan(RADIUS_RANK['l3-canon-proposal']);
  });
});

describe('isBlastRadiusWithin', () => {
  it('accepts when plan is narrower than envelope', () => {
    expect(isBlastRadiusWithin('tooling', 'framework')).toBe(true);
  });
  it('accepts when equal', () => {
    expect(isBlastRadiusWithin('framework', 'framework')).toBe(true);
  });
  it('rejects when plan is wider than envelope', () => {
    expect(isBlastRadiusWithin('framework', 'tooling')).toBe(false);
  });
});

describe('findIntentInProvenance', () => {
  // Uses a mock host shape; fill per actual Host interface.
  const makeHost = (atoms: Record<string, any>) => ({
    atoms: { get: async (id: string) => atoms[id] ?? null },
  });

  it('returns the intent id when plan.provenance.derived_from includes an operator-intent atom', async () => {
    const host = makeHost({
      'intent-1': { id: 'intent-1', type: 'operator-intent' },
      'canon-1': { id: 'canon-1', type: 'directive' },
    });
    const plan = { provenance: { derived_from: ['canon-1', 'intent-1'] } };
    expect(await findIntentInProvenance(host as any, plan as any)).toBe('intent-1');
  });
  it('returns null when no intent is cited', async () => {
    const host = makeHost({
      'canon-1': { id: 'canon-1', type: 'directive' },
    });
    const plan = { provenance: { derived_from: ['canon-1'] } };
    expect(await findIntentInProvenance(host as any, plan as any)).toBeNull();
  });
  it('does NOT do a transitive walk (v1: direct-only)', async () => {
    const host = makeHost({
      'intent-1': { id: 'intent-1', type: 'operator-intent' },
      'question-1': { id: 'question-1', type: 'question', provenance: { derived_from: ['intent-1'] } },
    });
    const plan = { provenance: { derived_from: ['question-1'] } };
    expect(await findIntentInProvenance(host as any, plan as any)).toBeNull();
  });
  it('handles missing atom gracefully', async () => {
    const host = makeHost({});
    const plan = { provenance: { derived_from: ['missing-id'] } };
    expect(await findIntentInProvenance(host as any, plan as any)).toBeNull();
  });
});
```

- [ ] **Step 2: Run; verify failure (import not found)**

- [ ] **Step 3: Implement helpers**

```typescript
// src/runtime/actor-message/intent-approve.ts
import type { Atom, Host } from '../../substrate/types.js';

export const RADIUS_RANK = {
  none: 0,
  docs: 1,
  tooling: 2,
  framework: 3,
  'l3-canon-proposal': 4,
} as const;

export type BlastRadius = keyof typeof RADIUS_RANK;

export function isBlastRadiusWithin(planRadius: BlastRadius, envelopeMax: BlastRadius): boolean {
  return RADIUS_RANK[planRadius] <= RADIUS_RANK[envelopeMax];
}

export async function findIntentInProvenance(host: Host, plan: Atom): Promise<string | null> {
  const derived = plan.provenance?.derived_from ?? [];
  for (const id of derived) {
    const atom = await host.atoms.get(id);
    if (atom?.type === 'operator-intent') return id;
  }
  return null;
}
```

- [ ] **Step 4: Run; verify pass**

- [ ] **Step 5: Commit**

```bash
git add src/runtime/actor-message/intent-approve.ts test/runtime/actor-message/intent-approve.test.ts
git commit -m "intent-approve: RADIUS_RANK + isBlastRadiusWithin + findIntentInProvenance helpers"
```

---

## Task 9: runIntentAutoApprovePass tick (TDD)

**Files:**
- Modify: `src/runtime/actor-message/intent-approve.ts`
- Modify: `test/runtime/actor-message/intent-approve.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// Extend test/runtime/actor-message/intent-approve.test.ts
import { runIntentAutoApprovePass } from '../../../src/runtime/actor-message/intent-approve.js';

describe('runIntentAutoApprovePass', () => {
  // Build an in-memory host fixture with policies + an intent + a plan; expect approval.
  // Tests:
  // 1. Happy path: envelope matches -> plan.plan_state transitions 'proposed' -> 'approved'.
  // 2. Kill-switch tripped -> halted: true, no mutations.
  // 3. Expired intent -> rejected++, no mutation.
  // 4. Compromised intent (taint != 'clean') -> rejected++.
  // 5. Non-whitelisted intent principal -> rejected++.
  // 6. Confidence below envelope.min_plan_confidence -> skipped (not counted as rejected).
  // 7. Sub-actor not in envelope.allowed_sub_actors -> skipped.
  // 8. Blast-radius exceeds envelope.max_blast_radius -> skipped.
  // 9. Empty policy allowlist -> short-circuit, scanned: 0.
  // 10. Claim-before-mutate: plan state already changed by another worker -> no double-approve.
});
```

Each test constructs an in-memory host via `createMemoryHost` (existing helper in test fixtures; verify or add to `test/fixtures.ts`), seeds atoms, runs the tick, asserts.

- [ ] **Step 2: Implement the tick**

Per the spec section 4 pseudocode, faithfully. Key elements:
1. Kill-switch check at top.
2. Read `pol-plan-autonomous-intent-approve` via canon query.
3. Empty allowlist short-circuit.
4. Read `pol-operator-intent-creation` for principal allowlist.
5. Query proposed plans.
6. For each: findIntentInProvenance; if null, skip.
7. Load intent; check type, taint, expires_at, principal.
8. Envelope check: min_plan_confidence, allowed_sub_actors, blast_radius.
9. Claim-before-mutate: re-read plan, check plan_state, taint.
10. `host.atoms.update` with new state + metadata approval fields.
11. Auditor log.
12. Return counts.

- [ ] **Step 3: Run all intent-approve tests**

Expected: all new unit tests pass.

- [ ] **Step 4: Export from runtime/actor-message/index.ts**

Add `export * from './intent-approve.js';` (or named export as appropriate per existing pattern).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/actor-message/intent-approve.ts src/runtime/actor-message/index.ts test/runtime/actor-message/intent-approve.test.ts
git commit -m "intent-approve: runIntentAutoApprovePass tick (envelope check + claim-before-mutate + kill-switch)"
```

---

## Task 10: Canon atom bootstrap

**Files:**
- Create: `scripts/bootstrap-autonomous-intent-canon.mjs`

- [ ] **Step 1: Read reference bootstrap**

Read `scripts/bootstrap-dev-canon-proposals.mjs` for shape (ATOMS array, idempotent write loop, drift check).

- [ ] **Step 2: Write the bootstrap**

Create `scripts/bootstrap-autonomous-intent-canon.mjs` with three atoms:

**Atom 1:** `pol-operator-intent-creation`  -  see spec §4 for exact `fields` shape.

**Atom 2:** `pol-plan-autonomous-intent-approve`  -  see spec §4 for exact `fields` shape.

**Atom 3:** `dev-autonomous-intent-substrate-shape` directive:
```
Operator-authored operator-intent atoms with a trust_envelope authorize
autonomous plan-approval; non-operator-authored operator-intent atoms
are ignored by the autonomous path. Do not add non-operator principals
to pol-operator-intent-creation.allowed_principal_ids without a prior
operator-signed decision atom citing the broadening rationale.
```

Each atom includes `alternatives_rejected`, `what_breaks_if_revisit`, `derived_from`, `layer: 'L3'`, `confidence: 1.0`, `provenance` per existing bootstrap patterns.

- [ ] **Step 3: Dry-run verify (only if LAG_OPERATOR_ID set)**

```bash
cd .worktrees/autonomous-intent-substrate && npm run build --silent && node scripts/bootstrap-autonomous-intent-canon.mjs 2>&1 | tail -5
```

Expected: 3 atoms written on first run; idempotent-skip on rerun.

- [ ] **Step 4: Commit**

```bash
git add scripts/bootstrap-autonomous-intent-canon.mjs
git commit -m "canon: autonomous-intent substrate L3 atoms (pol-operator-intent-creation, pol-plan-autonomous-intent-approve, dev-autonomous-intent-substrate-shape)"
```

---

## Task 11: Wire `runIntentAutoApprovePass` into run-approval-cycle

**Files:**
- Modify: `scripts/run-approval-cycle.mjs`

- [ ] **Step 1: Import the new tick**

Add `runIntentAutoApprovePass` to the existing import from `../dist/actor-message/index.js`.

- [ ] **Step 2: Invoke as tick 0**

Before `runAutoApprovePass`, call:
```javascript
const intentResult = await runIntentAutoApprovePass(host);
console.log(`[approval-cycle] intent-approve     scanned=${intentResult.scanned} approved=${intentResult.approved} rejected=${intentResult.rejected}${intentResult.halted ? ' [HALTED by kill-switch]' : ''}`);
if (intentResult.halted) return;
```

- [ ] **Step 3: Smoke test**

```bash
cd .worktrees/autonomous-intent-substrate && npm run build --silent && node scripts/run-approval-cycle.mjs --once --root-dir . 2>&1 | head -10
```

Expected: new `intent-approve` line appears first in the output.

- [ ] **Step 4: Commit**

```bash
git add scripts/run-approval-cycle.mjs
git commit -m "run-approval-cycle: wire runIntentAutoApprovePass as tick 0"
```

---

## Task 12: Code-author dispatch invoker

**Files:**
- Create: `scripts/invokers/autonomous-dispatch.mjs`

- [ ] **Step 1: Locate the code-author invoker export**

Read `dist/actor-message/code-author-invoker.js` (built from `src/actor-message/code-author-invoker.ts`) to find the exported function signature. Note the name and shape of the invoker it expects from `SubActorRegistry.register`.

- [ ] **Step 2: Write the module**

```javascript
// scripts/invokers/autonomous-dispatch.mjs
/**
 * Dispatch-invoker registrar for run-approval-cycle --invokers <this-path>.
 * Registers code-author so plans with delegation.sub_actor_principal_id='code-author'
 * dispatch into the existing code-author flow (Question-to-PR).
 *
 * auditor-actor is registered by run-approval-cycle itself (read-only, always safe);
 * this module only adds code-author.
 *
 * CRITICAL: the wrapper also applies `autonomous-intent` and `plan-id:<id>`
 * labels to the PR after code-author opens it. These labels key the pr-landing
 * workflow's LAG-auditor gate (see .github/workflows/pr-landing.yml). Without
 * the labels, the auditor never runs, LAG-auditor status never posts, and
 * once branch protection requires that status (post-migration), every
 * intent-driven PR hangs indefinitely.
 */
import { execa } from 'execa';

export default async function register(host, registry) {
  const { runCodeAuthor } = await import('../../dist/actor-message/code-author-invoker.js');
  registry.register('code-author', async (plan, ctx) => {
    const result = await runCodeAuthor({ host, plan, ...ctx });
    const intentId = (plan.provenance?.derived_from ?? []).find((id) => id.startsWith('intent-'));
    if (result?.pr_number && intentId) {
      try {
        const repo = process.env.GH_REPO ?? 'stephengardner/layered-autonomous-governance';
        await execa('node', [
          'scripts/gh-as.mjs', 'lag-ceo',
          'api', `repos/${repo}/issues/${result.pr_number}/labels`,
          '-X', 'POST',
          '-f', 'labels[]=autonomous-intent',
          '-f', `labels[]=plan-id:${plan.id}`,
        ], { stdio: 'inherit' });
      } catch (err) {
        // Fail LOUD, not silent. PR stays open; labels missing; auditor gate
        // will hang. Operator sees the warning + investigates.
        console.error(`[autonomous-dispatch] WARNING: failed to label PR #${result.pr_number}: ${err.message}. LAG-auditor gate will not fire.`);
      }
    }
    return result;
  });
}
```

**IMPORTANT:** verify `runCodeAuthor`'s return shape by reading `src/actor-message/code-author-invoker.ts`; if the PR-number field is not `pr_number` (e.g., `prNumber`, `number`), adjust the guard + access above.

- [ ] **Step 3: Verify smoke**

```bash
node -e "import('./scripts/invokers/autonomous-dispatch.mjs').then(m => console.log('default export type:', typeof m.default))"
```

Expected: `default export type: function`.

- [ ] **Step 4: Commit**

```bash
git add scripts/invokers/autonomous-dispatch.mjs
git commit -m "invokers: autonomous-dispatch registers code-author for run-approval-cycle"
```

---

## Task 13: Auditor helpers (TDD)

**Files:**
- Create: `scripts/lib/auditor.mjs`
- Create: `test/scripts/auditor.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, it } from 'vitest';
import { classifyDiffBlastRadius, computeVerdict } from '../../scripts/lib/auditor.mjs';

describe('classifyDiffBlastRadius', () => {
  it('returns docs when only docs/ or *.md files change', () => {
    expect(classifyDiffBlastRadius(['docs/foo.md', 'README.md'])).toBe('docs');
  });
  it('returns tooling when only scripts/ or config changes', () => {
    expect(classifyDiffBlastRadius(['scripts/foo.mjs', 'package.json'])).toBe('tooling');
  });
  it('returns framework when src/ changes', () => {
    expect(classifyDiffBlastRadius(['src/runtime/foo.ts'])).toBe('framework');
  });
  it('returns l3-canon-proposal when scripts/bootstrap-*-canon.mjs changes', () => {
    expect(classifyDiffBlastRadius(['scripts/bootstrap-dev-canon.mjs'])).toBe('l3-canon-proposal');
  });
  it('returns framework for mixed src + tooling', () => {
    expect(classifyDiffBlastRadius(['scripts/x.mjs', 'src/y.ts'])).toBe('framework');
  });
});

describe('computeVerdict', () => {
  it('passes when diff-radius is within envelope', () => {
    expect(computeVerdict({ diffRadius: 'tooling', envelopeMax: 'framework' })).toEqual({ verdict: 'pass', reason: 'within envelope' });
  });
  it('fails when diff-radius exceeds envelope', () => {
    const r = computeVerdict({ diffRadius: 'framework', envelopeMax: 'tooling' });
    expect(r.verdict).toBe('fail');
  });
});
```

- [ ] **Step 2: Verify failure**

- [ ] **Step 3: Implement**

```javascript
// scripts/lib/auditor.mjs
const RANK = { none: 0, docs: 1, tooling: 2, framework: 3, 'l3-canon-proposal': 4 };

export function classifyDiffBlastRadius(files) {
  if (!Array.isArray(files) || files.length === 0) return 'none';
  let max = 0;
  for (const f of files) {
    if (f.startsWith('scripts/bootstrap-') && f.endsWith('-canon.mjs')) {
      max = Math.max(max, RANK['l3-canon-proposal']);
    } else if (f.startsWith('src/')) {
      max = Math.max(max, RANK['framework']);
    } else if (f.startsWith('scripts/') || f === 'package.json' || f === 'package-lock.json' || f.endsWith('.yml') || f.endsWith('.yaml') || f.endsWith('.json')) {
      max = Math.max(max, RANK['tooling']);
    } else if (f.startsWith('docs/') || f.endsWith('.md')) {
      max = Math.max(max, RANK['docs']);
    } else {
      max = Math.max(max, RANK['tooling']);  // conservative default for unknown paths
    }
  }
  return Object.entries(RANK).find(([, r]) => r === max)?.[0] ?? 'none';
}

export function computeVerdict({ diffRadius, envelopeMax }) {
  if (RANK[diffRadius] <= RANK[envelopeMax]) {
    return { verdict: 'pass', reason: 'within envelope' };
  }
  return {
    verdict: 'fail',
    reason: `diff radius ${diffRadius} exceeds envelope ${envelopeMax}`,
  };
}
```

- [ ] **Step 4: Verify pass + commit**

```bash
npx vitest run test/scripts/auditor.test.ts
git add scripts/lib/auditor.mjs test/scripts/auditor.test.ts
git commit -m "auditor: classifyDiffBlastRadius + computeVerdict pure helpers"
```

---

## Task 14: `run-auditor.mjs` CLI

**Files:**
- Create: `scripts/run-auditor.mjs`

- [ ] **Step 1: Write the CLI**

```javascript
#!/usr/bin/env node
/**
 * run-auditor: invoked from pr-landing workflow when a PR carries a
 * plan-id: <id> label. Fetches PR diff, classifies blast radius,
 * compares to intent envelope, writes:
 *   1. An observation atom (kind: 'auditor-plan-check') with the verdict.
 *   2. A GitHub Commit Status under context 'LAG-auditor' with state
 *      'success' (verdict=pass) or 'failure' (verdict=fail).
 *
 * Usage:
 *   node scripts/run-auditor.mjs --pr <number> --plan <plan-id>
 *
 * Exit codes:
 *   0 - verdict pass (status posted, atom written)
 *   1 - verdict fail (status posted, atom written)
 *   2 - invocation error (args, env, missing atom)
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { createFileHost } from '../dist/adapters/file/index.js';
import { classifyDiffBlastRadius, computeVerdict } from './lib/auditor.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');
const REPO = 'stephengardner/layered-autonomous-governance';

function parseArgs(argv) {
  const a = { pr: null, plan: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pr' && i + 1 < argv.length) a.pr = argv[++i];
    else if (argv[i] === '--plan' && i + 1 < argv.length) a.plan = argv[++i];
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pr || !args.plan) {
    console.error('[auditor] usage: --pr <number> --plan <plan-id>');
    process.exit(2);
  }
  const host = await createFileHost({ rootDir: STATE_DIR });
  const plan = await host.atoms.get(args.plan);
  if (!plan || plan.type !== 'plan') {
    console.error(`[auditor] plan atom ${args.plan} not found or wrong type`);
    process.exit(2);
  }
  const intentId = (plan.provenance.derived_from ?? []).find((id) => id.startsWith('intent-'));
  if (!intentId) {
    console.error('[auditor] plan has no intent in provenance; auditor gate only applies to intent-driven plans');
    process.exit(2);
  }
  const intent = await host.atoms.get(intentId);
  const envelopeMax = intent?.metadata?.trust_envelope?.max_blast_radius;
  if (!envelopeMax) {
    console.error('[auditor] intent missing trust_envelope.max_blast_radius');
    process.exit(2);
  }

  // Fetch the PR diff files via gh.
  const { stdout } = await execa('gh', ['pr', 'view', args.pr, '--json', 'files', '--jq', '.files[].path']);
  const files = stdout.trim().split('\n').filter(Boolean);
  const diffRadius = classifyDiffBlastRadius(files);
  const { verdict, reason } = computeVerdict({ diffRadius, envelopeMax });
  console.log(`[auditor] plan=${args.plan} pr=${args.pr} diffRadius=${diffRadius} envelope=${envelopeMax} -> ${verdict}`);

  // Write verdict atom.
  const nowIso = new Date().toISOString();
  const verdictAtom = {
    schema_version: 1,
    id: `auditor-plan-check-${args.plan}-${nowIso.replace(/[:.]/g, '-')}`,
    type: 'observation',
    layer: 'L1',
    principal_id: 'auditor-actor',
    provenance: {
      kind: 'agent-observed',
      source: { tool: 'run-auditor', agent_id: 'auditor-actor' },
      derived_from: [args.plan, intentId],
    },
    confidence: 1,
    scope: 'project',
    content: `Auditor verdict=${verdict}. ${reason}. diffRadius=${diffRadius} envelopeMax=${envelopeMax}.`,
    metadata: {
      kind: 'auditor-plan-check',
      verdict,
      reason,
      diff_files: files,
      diff_radius: diffRadius,
      envelope_max: envelopeMax,
      pr_number: Number(args.pr),
      plan_id: args.plan,
      intent_id: intentId,
    },
    created_at: nowIso,
    last_reinforced_at: nowIso,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    taint: 'clean',
    signals: { agrees_with: [], disagrees_with: [], refined_by: [] },
  };
  await host.atoms.put(verdictAtom);

  // Write GitHub Commit Status via gh api.
  const { stdout: headSha } = await execa('gh', ['pr', 'view', args.pr, '--json', 'headRefOid', '--jq', '.headRefOid']);
  const sha = headSha.trim();
  const state = verdict === 'pass' ? 'success' : 'failure';
  await execa('gh', [
    'api', `repos/${REPO}/statuses/${sha}`,
    '-f', `state=${state}`,
    '-f', `context=LAG-auditor`,
    '-f', `description=${reason.slice(0, 140)}`,
  ]);
  console.log(`[auditor] LAG-auditor status posted: ${state}`);

  process.exit(verdict === 'pass' ? 0 : 1);
}

main().catch((err) => {
  console.error(`[auditor] ${err.message}`);
  process.exit(2);
});
```

- [ ] **Step 2: Smoke (without writing atoms)**

Test arg-validation by running without args; expect exit 2.

```bash
node scripts/run-auditor.mjs 2>&1 | head
```

Expected: "usage: --pr --plan".

- [ ] **Step 3: Commit**

```bash
git add scripts/run-auditor.mjs
git commit -m "run-auditor: CLI writing verdict atom + LAG-auditor GitHub commit status"
```

---

## Task 15: pr-landing.yml auditor step

**Files:**
- Modify: `.github/workflows/pr-landing.yml`

- [ ] **Step 1: Locate the existing jobs**

Read the workflow. Find the main job; note where pr-landing actor is invoked.

- [ ] **Step 2: Add a new job (or step) `lag-auditor`**

```yaml
  lag-auditor:
    name: LAG auditor gate
    runs-on: ubuntu-latest
    if: |
      github.event_name == 'pull_request' &&
      contains(github.event.pull_request.labels.*.name, 'autonomous-intent')
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: Install (skip native post-install)
        run: npm ci --ignore-scripts
      - name: Build
        run: npm run build
      - name: Extract plan-id label
        id: plan
        run: |
          PLAN_ID=$(jq -r '.pull_request.labels[] | select(.name | startswith("plan-id:")) | .name | split(":")[1]' "$GITHUB_EVENT_PATH")
          echo "plan-id=$PLAN_ID" >> "$GITHUB_OUTPUT"
      - name: Run auditor
        if: steps.plan.outputs.plan-id != ''
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: node scripts/run-auditor.mjs --pr ${{ github.event.pull_request.number }} --plan ${{ steps.plan.outputs.plan-id }}
```

**Both labels required**: the job's `if:` gates on `autonomous-intent` in labels; the step-level `if:` gates on non-empty `plan-id:` output. Both labels MUST be applied by the autonomous-dispatch invoker (Task 12); a PR missing either label SKIPS the job, so `LAG-auditor` status never posts. After Task 16's migration runs, a PR without both labels will hang indefinitely awaiting the required check.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/pr-landing.yml
git commit -m "workflows: pr-landing auditor gate step for autonomous-intent labeled PRs"
```

---

## Task 16: Branch-protection migration

**Files:**
- Create: `scripts/migrations/2026-04-24-add-lag-auditor-status-check.mjs`

- [ ] **Step 1: Write the idempotent script**

```javascript
#!/usr/bin/env node
/**
 * Migration: add LAG-auditor as a required status check on main.
 * Idempotent. Operator runs once POST-MERGE of the autonomous-intent PR.
 *
 * Usage:
 *   node scripts/migrations/2026-04-24-add-lag-auditor-status-check.mjs
 *
 * Requires: gh CLI with admin on the repo.
 */
import { execa } from 'execa';

const REPO = 'stephengardner/layered-autonomous-governance';
const BRANCH = 'main';
const CONTEXT = 'LAG-auditor';

async function main() {
  const cur = await execa('gh', ['api', `repos/${REPO}/branches/${BRANCH}/protection`]);
  const protection = JSON.parse(cur.stdout);
  const contexts = protection.required_status_checks?.contexts ?? [];
  if (contexts.includes(CONTEXT)) {
    console.log(`[migration] ${CONTEXT} already in required_status_checks.contexts; no change.`);
    return;
  }
  const next = [...contexts, CONTEXT];
  const body = JSON.stringify({ contexts: next, strict: protection.required_status_checks?.strict ?? true });
  await execa('gh', [
    'api', `repos/${REPO}/branches/${BRANCH}/protection/required_status_checks`,
    '-X', 'PATCH',
    '--input', '-',
  ], { input: body });
  console.log(`[migration] added ${CONTEXT} to required_status_checks. Now: ${next.join(', ')}`);
}
main().catch((err) => { console.error(err); process.exit(1); });
```

Uses the repo's standard `execa` import pattern (see `scripts/git-as.mjs`, `scripts/gh-as.mjs`). Argv-array form (not shell-string) avoids quoting pitfalls. The PATCH body is piped via `--input -` so nested JSON is preserved.

- [ ] **Step 2: Do NOT run the migration in this PR**

Per the spec, the migration runs POST-MERGE. This script is artifact-only for this PR; ship it, don't invoke.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrations/2026-04-24-add-lag-auditor-status-check.mjs
git commit -m "migrations: idempotent LAG-auditor required-status-check addition (run post-merge)"
```

---

## Task 17: `intend` npm script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add script**

```json
"intend": "node scripts/intend.mjs",
```

- [ ] **Step 2: Verify**

```bash
npm run intend -- --help 2>&1 | head
```

Expected: usage text; exit non-zero (missing required args) but the script is dispatched correctly.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "intend: add npm run intend script"
```

---

## Task 18: Integration round-trip test (gated)

**Files:**
- Create: `test/integration/autonomous-intent-e2e.test.ts`

- [ ] **Step 1: Write the test**

Gated behind `LAG_AUTONOMOUS_E2E=1`. Creates a throwaway host dir; writes an operator-intent atom; runs the CTO (stub mode); runs `runIntentAutoApprovePass`; asserts the plan transitions to `approved`. Does NOT invoke code-author (mock invoker substituted).

~60 lines; use in-memory host from `test/fixtures.ts` or a throwaway file-host under `os.tmpdir()`.

- [ ] **Step 2: Run gated + ungated**

```bash
npx vitest run test/integration/autonomous-intent-e2e.test.ts          # ungated: skips cleanly
LAG_AUTONOMOUS_E2E=1 npx vitest run test/integration/autonomous-intent-e2e.test.ts  # gated: runs, passes
```

- [ ] **Step 3: Commit**

```bash
git add test/integration/autonomous-intent-e2e.test.ts
git commit -m "test(integration): autonomous-intent e2e round-trip (gated LAG_AUTONOMOUS_E2E=1)"
```

---

## Task 19: Memory update + pointer in MEMORY.md

**Files:**
- Modify: `C:\Users\opens\.claude\projects\C--Users-opens-memory-governance\memory\MEMORY.md`
- Create: `C:\Users\opens\.claude\projects\C--Users-opens-memory-governance\memory\project_autonomous_intent_substrate_shipped.md`

- [ ] **Step 1: Write the memory body**

Focus: the "two pipelines exist, when to use each" reconciliation + the intent atom as declarative surface.

- [ ] **Step 2: Add index pointer**

Single one-line entry in MEMORY.md.

- [ ] **Step 3: No git action** (memory lives outside repo).

---

## Task 20: Pre-push verify + PR

**Files:** none (shell only)

- [ ] **Step 1: Full test suite**

```bash
cd .worktrees/autonomous-intent-substrate && npm test 2>&1 | tail -10
LAG_AUTONOMOUS_E2E=1 npx vitest run test/integration/autonomous-intent-e2e.test.ts 2>&1 | tail -5
```

Expected: all tests pass.

- [ ] **Step 2: Pre-push grep checklist**

Read the canonical pattern from `feedback_pre_push_grep_checklist` memory first. Minimum three checks:

```bash
# 1. Emdashes and endashes (U+2014, U+2013) in tracked text files
grep -rP '[\x{2014}\x{2013}]' --include='*.md' --include='*.ts' --include='*.mjs' --include='*.json' --include='*.yml' . 2>/dev/null | grep -v node_modules | grep -v '\.git/' | head

# 2. AI attribution (Co-Authored-By, Generated-with markers)
grep -rE '(Co-Authored-By|Generated with Claude|Generated by Claude)' --include='*.md' --include='*.ts' --include='*.mjs' --include='*.json' . 2>/dev/null | grep -v node_modules | head

# 3. src/ JSDoc design-link references (per feedback_src_docs_mechanism_only_no_design_links)
grep -nE 'design/|DECISIONS|phase-5[0-9]|dev-|inv-|pol-' src/ -r --include='*.ts' 2>&1 | grep -vE '//\s*TODO|//\s*NOTE.*canon' | head
```

Expected: all three empty. Any hit = fix before push.

- [ ] **Step 3: Rebase onto latest main to avoid BEHIND**

```bash
git fetch origin main
git rebase origin/main
```

Resolve conflicts if any; re-run tests after rebase.

- [ ] **Step 4: Push via lag-ceo**

```bash
npm run build
node scripts/git-as.mjs lag-ceo push -u origin feat/autonomous-intent-substrate 2>&1 | tail -5
```

- [ ] **Step 5: Open PR via gh-as lag-ceo**

```bash
node scripts/gh-as.mjs lag-ceo pr create --head feat/autonomous-intent-substrate --title "feat: autonomous-intent substrate (operator-intent atom + trust envelope + plan-state autonomous propagation)" --body "$(cat <<'EOF'
## Summary

Ships the substrate that closes the plan-approval pipeline's loop end-to-end: operator declares autonomous-solve intent via operator-intent atom with a trust envelope; CTO drafts plans with explicit delegation; new runIntentAutoApprovePass tick auto-approves plans whose provenance derives from a fresh intent matching the envelope; code-author dispatches into a PR; auditor pre-flight posts LAG-auditor GitHub status; reconcile tick closes the plan on PR merge. Design at docs/superpowers/specs/2026-04-24-autonomous-intent-substrate-design.md.

## What lands

- New operator-intent atom type with trust envelope.
- scripts/intend.mjs CLI (kill-switch gated, operator-id checked, --dry-run, --trigger).
- planDraftOutput schema extended with required delegation field; PLAN_DRAFT prompt guidance added.
- planning-actor writes delegation + intent id into plan atom (provenance chain).
- New runIntentAutoApprovePass tick (envelope check, claim-before-mutate, kill-switch).
- Three canon atoms (pol-operator-intent-creation, pol-plan-autonomous-intent-approve, dev-autonomous-intent-substrate-shape).
- Code-author dispatch invoker for run-approval-cycle.
- scripts/run-auditor.mjs + lib/auditor.mjs (blast-radius classification, verdict).
- pr-landing.yml: LAG-auditor gate gated on autonomous-intent + plan-id: labels.
- Branch-protection migration script (run post-merge).
- Skill at .claude/skills/autonomous-intent/SKILL.md.
- Full unit + integration (gated) test coverage.

## Bootstrap paradox

This PR cannot self-approve (no intent authorizes the substrate that implements intent). Ships via standard human-reviewed flow. Post-merge, a dogfood issues the first real intent to validate the full pipeline.

## Test plan

- [ ] npm test passes
- [ ] LAG_AUTONOMOUS_E2E=1 npm test passes the e2e
- [ ] Pre-push grep clean
- [ ] Post-merge: run migration script to add LAG-auditor required check
- [ ] Post-merge: write first operator-intent atom via `intend --trigger` and observe the plan propagate proposed -> approved -> executing -> succeeded

## Out of scope (explicit)

- No L3 canon automation.
- No bot-authored intents.
- No peer-review bots.
- No retroactive migration of 18 stuck plans.
- No existing pipeline-B (code-author Question->PR) changes.

## Related canon

- inv-governance-before-autonomy
- inv-kill-switch-first
- inv-l3-requires-human (preserved; intent cannot authorize canon-write-l3)
- dev-canon-is-strategic-not-tactical
- dev-indie-floor-org-ceiling
EOF
)" 2>&1 | tail -5
```

- [ ] **Step 6: Report PR URL + state**

```bash
gh pr view --json url,state,mergeStateStatus
```

---

## Post-merge follow-ups (out of this plan)

1. Run migration: `node scripts/migrations/2026-04-24-add-lag-auditor-status-check.mjs`.
2. Dogfood: issue first operator-intent via `npm run intend -- --request "X" --scope tooling --blast-radius framework --sub-actors code-author --trigger`; watch `/plans` in the console for state progression.
3. Apply CTO's prior Plan 3 (sweep stale proposed plans via auto-expiry).
4. Add peer-review tick (multi-reviewer deliberation bots).
5. Ship `pol-autonomy-dial-*` canon (option C).
6. Observation firehose fix (the operator said they don't mind, but the activities.list cap + type-filter still improves UX).
