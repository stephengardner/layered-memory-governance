# CR-Precheck Capability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **CANON-AUDIT GATE (mandatory per `dev-implementation-canon-audit-loop`):** every substantive task includes a "canon-audit" step BETWEEN spec/code-quality reviewers and "commit." See spec §9.1.
>
> **BOOTSTRAP-EXEMPT:** Tasks 1-N implement the cr-precheck helper itself; cr-precheck cannot run on its own implementation tasks. Per spec §9.1, the auditor is told these tasks are exempt from the "must run cr-precheck" check until the helper exists. Task FINAL is the first user.

**Goal:** Ship `scripts/cr-precheck.mjs` (progressive-enhancement pre-push CR CLI helper), a query companion `scripts/cr-precheck-audit.mjs`, a CI backstop workflow, and operator docs. Activate the `dev-coderabbit-cli-pre-push` canon for environments where CR CLI is reachable.

**Architecture:** Single Node helper script that detects CR CLI on PATH. If found: runs `coderabbit review --plain` on the diff, blocks push on critical/major findings, writes a `cr-precheck-run` audit atom on success or a `cr-precheck-skip` atom on CLI error. If NOT found: prints LOUD warning + writes a `cr-precheck-skip` atom + exits 0 (progressive enhancement, not a hard block). CI backstop guarantees CR CLI runs at merge time regardless of contributor's local environment.

**Tech Stack:** Node.js (`*.mjs`), bash (Git Bash on Windows), GitHub Actions (Linux runner for CI backstop), CR CLI v0.4.2.

**Spec source:** `docs/superpowers/specs/2026-04-25-cr-precheck-capability-design.md` (head `fa27b77` on branch `feat/cr-precheck`).

**Branch:** `feat/cr-precheck` (worktree at `.worktrees/cr-precheck/`).

---

## File structure (locked decomposition)

| File | Purpose | Task |
|---|---|---|
| `scripts/cr-precheck.mjs` | Pre-push helper (the main user-facing tool) | Task 1 |
| `scripts/cr-precheck-audit.mjs` | Query companion to inspect skip + run atoms | Task 2 |
| `.github/workflows/cr-precheck.yml` | CI backstop | Task 3 |
| `docs/cr-precheck.md` | Operator doc | Task 4 |
| `test/scripts/cr-precheck.test.mjs` | Unit tests for the helper | Task 1 (TDD) |
| `test/scripts/cr-precheck-audit.test.mjs` | Unit tests for the audit query | Task 2 (TDD) |
| (validation) | Pre-push canon-audit + push + open PR + drive to merge | Task 5 |

Verify before Task 1: the repo's existing pattern for `scripts/*.mjs` tests is `test/scripts/*.test.mjs` per the existing `test/scripts/git-as-push-auth.test.ts` precedent (note: that's `.ts`; if vitest's transformer prefers TS over MJS for tests, follow the prevailing pattern). The implementer's first action is to grep `test/scripts/` for the existing test file extension convention and follow it.

---

## Task 1: `scripts/cr-precheck.mjs` -- the helper

**Files:**
- Create: `scripts/cr-precheck.mjs`
- Test: `test/scripts/cr-precheck.test.mjs` (or `.ts` per prevailing convention)

**Security + correctness considerations:**
- The helper writes to `.lag/atoms/`. This is the same trust boundary as the rest of `.lag/`. `.lag/` is gitignored at the framework default; the audit atom never leaks to GitHub.
- The helper invokes `coderabbit` as a subprocess. The CR CLI sends the diff to CR's API; same data flow as today's CR web review (no new exfiltration).
- No `--no-audit` flag (per spec §3.1, intentionally NOT shipped to avoid silent-skip vector). Operator-only `CR_PRECHECK_DRY_RUN=1` env var for one-off testing; defined here for the spec record but the implementation MAY defer the dry-run handling to a follow-up.
- LOUD detection logging is non-bypassable. Both found and not-found paths print a single line to stderr that the operator/agent can grep.
- CLI-error case (CR CLI present but errors out) writes a `cr-precheck-skip` atom AND exits non-zero. Does NOT silently fall through to "review passed."

- [ ] **Step 1: Verify test convention**

```bash
ls test/scripts/ 2>&1 | head -10
```

If the existing tests are `.test.ts`, write the new test as `.test.ts`. If `.test.mjs`, follow that. Document the choice in the commit message.

- [ ] **Step 2: Write the failing tests**

The test file imports the helper's pure functions (the side-effect-free ones; the helper exports them for testability). Suggested exports from `cr-precheck.mjs`:

- `findCoderabbitOnPath(): string | null` -- returns absolute path to `coderabbit` binary or null
- `parseCrCliFindings(plainOutput: string): { critical: number; major: number; minor: number }` -- parses `coderabbit review --plain` stdout
- `decideExitCode(findings, opts): { exitCode: number; reason: string }` -- maps findings to exit code given strict flag

The script's `main()` orchestrates: detect → diff → invoke → parse → decide → audit. The CLI entrypoint pattern matches the existing `scripts/decide.mjs` and `scripts/git-as.mjs` shape.

Test cases (write all before implementation):

```ts
describe('findCoderabbitOnPath', () => {
  it('returns path when coderabbit is on PATH', () => { /* mock execSync('command -v coderabbit') */ });
  it('returns null when not on PATH', () => { /* mock returns empty */ });
});
describe('parseCrCliFindings', () => {
  it('parses plain output with 0 findings', () => {});
  it('parses plain output with mixed severities', () => {});
  it('returns zero counts on empty output', () => {});
});
describe('decideExitCode', () => {
  it('returns 0 on 0 critical + 0 major', () => {});
  it('returns 1 on any critical', () => {});
  it('returns 1 on any major', () => {});
  it('returns 1 on minor with --strict', () => {});
  it('returns 0 on minor without --strict', () => {});
});
```

The full `main()` orchestration is integration-tested at Task 5 (e2e) since it requires real CR CLI invocation.

- [ ] **Step 3: Verify failure**

```bash
npx vitest run test/scripts/cr-precheck.test.mjs   # OR .test.ts
```

Expected: FAIL (module not found, function not exported).

- [ ] **Step 4: Implement**

Create `scripts/cr-precheck.mjs` per spec §3.1 + §3.4. Key behaviors:

```js
#!/usr/bin/env node
// scripts/cr-precheck.mjs

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export function findCoderabbitOnPath() {
  // Prefer 'coderabbit' over 'cr' (cr is a common alias for other tools too).
  for (const name of ['coderabbit', 'cr']) {
    try {
      const out = execSync(`command -v ${name}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (out) return out;
    } catch {}
  }
  return null;
}

export function parseCrCliFindings(plainOutput) {
  // Parse the --plain output. Confirm the actual shape by running CR CLI on a
  // test diff with known findings; the parser shape MUST match. Verify before shipping.
  const counts = { critical: 0, major: 0, minor: 0 };
  // ... regex / line-walk implementation per CR CLI docs ...
  return counts;
}

export function decideExitCode(findings, opts = {}) {
  const { strict = false } = opts;
  if (findings.critical > 0) return { exitCode: 1, reason: `${findings.critical} critical finding(s)` };
  if (findings.major > 0) return { exitCode: 1, reason: `${findings.major} major finding(s)` };
  if (strict && findings.minor > 0) return { exitCode: 1, reason: `${findings.minor} minor finding(s) with --strict` };
  return { exitCode: 0, reason: 'clean' };
}

async function writeAtom(kind, payload, lagDir) {
  // Write to .lag/atoms/<atomId>.json with the project-scope observation atom shape.
  // Atom id: cr-precheck-<kind>-<hex8>
  // metadata: { kind: 'cr-precheck-skip' | 'cr-precheck-run', cr_precheck_skip OR cr_precheck_run: payload }
  // ... implementation ...
}

async function main() {
  const args = parseArgs(process.argv);
  const dryRun = process.env.CR_PRECHECK_DRY_RUN === '1';
  if (dryRun) {
    console.error('[cr-precheck] CR_PRECHECK_DRY_RUN=1 set; running in dry-run mode (no audit atom write).');
  }
  const cliPath = findCoderabbitOnPath();
  if (cliPath === null) {
    console.error('[cr-precheck] coderabbit NOT FOUND on PATH; canon dev-coderabbit-cli-pre-push expects this run. Skipping local pre-push CR review (CI backstop will run it server-side).');
    if (!dryRun) await writeAtom('cr-precheck-skip', { reason: 'coderabbit-not-on-path', /* ... */ }, args.lagDir);
    return 0;
  }
  // Get version
  let version = 'unknown';
  try {
    const v = execSync(`"${cliPath}" --version`, { encoding: 'utf8' }).trim();
    version = v;
  } catch {}
  console.error(`[cr-precheck] found coderabbit at ${cliPath} v${version}`);

  // Compute diff
  const diff = execSync(`git diff ${args.base}...HEAD`, { encoding: 'utf8' });
  if (diff.trim().length === 0) {
    console.error(`[cr-precheck] no diff vs ${args.base}; nothing to review.`);
    return 0;
  }

  // Invoke CR CLI
  const start = Date.now();
  const result = spawnSync(cliPath, ['review', '--plain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const duration = Date.now() - start;

  if (result.status !== 0 && result.status !== null) {
    console.error(`[cr-precheck] coderabbit exited ${result.status}; treating as cli-error.`);
    console.error(result.stderr);
    if (!dryRun) await writeAtom('cr-precheck-skip', { reason: 'cli-error', cli_error_message: result.stderr.slice(0, 500), /* ... */ }, args.lagDir);
    return 1;
  }

  const findings = parseCrCliFindings(result.stdout);
  const decision = decideExitCode(findings, { strict: args.strict });

  if (!dryRun) await writeAtom('cr-precheck-run', { findings, cli_version: version, duration_ms: duration, /* ... */ }, args.lagDir);

  console.error(`[cr-precheck] findings: critical=${findings.critical} major=${findings.major} minor=${findings.minor}; decision=${decision.reason}`);
  if (decision.exitCode !== 0) {
    console.error(result.stdout);  // print the findings so the operator/agent can read them
  }
  return decision.exitCode;
}

if (process.argv[1] && process.argv[1].endsWith('cr-precheck.mjs')) {
  main().then(code => process.exit(code)).catch(err => { console.error('[cr-precheck] unexpected error:', err); process.exit(2); });
}
```

(Refine against actual CR CLI v0.4.2 output shape.)

- [ ] **Step 5: Run + verify pass**

```bash
npx vitest run test/scripts/cr-precheck.test.mjs
npx vitest run    # full suite
npm run typecheck && npm run build
```

All green.

- [ ] **Step 6: Pre-commit grep**

```bash
node -e "const fs=require('fs');const t=fs.readFileSync('scripts/cr-precheck.mjs','utf8');const m=t.match(/\u2014/g);console.log('emdashes:',m?m.length:0);"
```

Empty.

- [ ] **Step 7: Canon-audit (per dev-implementation-canon-audit-loop)**

Dispatch canon-audit subagent with the canon, this task's text, and the diff. **Special note for auditor:** this task is BOOTSTRAP-EXEMPT from the "verify cr-precheck was run" check (the helper doesn't exist before this commit; once committed, subsequent tasks DO run it).

Audit checklist (specific to this task):
1. Atom shape matches spec §3.4 (discriminated `metadata.kind`; one payload key only)
2. Skip-atom written on not-found AND on cli-error
3. NO atom written on empty-diff (no-op, not a skip)
4. Exit codes: 0 on clean / 1 on findings-or-cli-error
5. LOUD detection logging on both found and not-found paths
6. No `--no-audit` flag (silent-skip vector)
7. `CR_PRECHECK_DRY_RUN` env var works (operator-only, not flag-driven)
8. JSDoc / comments don't introduce design refs / canon ids / actor names

- [ ] **Step 8: Commit**

```bash
node ../../scripts/git-as.mjs lag-ceo add scripts/cr-precheck.mjs test/scripts/cr-precheck.test.mjs
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(cr-precheck): pre-push helper with progressive enhancement + audit atom"
```

DO NOT push. Plan controller pushes at Task 5.

---

## Task 2: `scripts/cr-precheck-audit.mjs` -- query companion

**Files:**
- Create: `scripts/cr-precheck-audit.mjs`
- Test: `test/scripts/cr-precheck-audit.test.mjs` (or `.ts`)

**Security + correctness considerations:**
- Read-only against `.lag/atoms/`. No mutation; safe to run repeatedly.
- Filters by `metadata.kind` (cr-precheck-skip / cr-precheck-run). Reuses the discriminator from Task 1.
- Sorts newest-first by `captured_at`.

- [ ] **Step 1: Write the failing test**

```ts
describe('cr-precheck-audit', () => {
  it('lists cr-precheck-skip atoms newest-first', async () => { /* seed MemoryHost; run query */ });
  it('lists cr-precheck-run atoms newest-first', async () => {});
  it('filters by --since duration', async () => {});
  it('returns empty when no atoms match', async () => {});
});
```

- [ ] **Step 2: Verify failure**

- [ ] **Step 3: Implement**

```js
#!/usr/bin/env node
// scripts/cr-precheck-audit.mjs

// Usage: node scripts/cr-precheck-audit.mjs [--since 24h] [--kind skip|run] [--limit 50]

import { createFileHost } from '../dist/adapters/file/index.js';
// ... read .lag/atoms/, filter, sort, print ...
```

- [ ] **Step 4-7:** Run pass / pre-commit / canon-audit / commit. Same shape as Task 1.

```bash
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(cr-precheck-audit): query companion for skip + run atoms"
```

---

## Task 3: `.github/workflows/cr-precheck.yml` -- CI backstop

**Files:**
- Create: `.github/workflows/cr-precheck.yml`

**Security + correctness considerations:**
- Runs on Linux runner (CR CLI install script supports Linux natively; no Windows-package needed in CI).
- API key (if needed) stored as repo secret `CODERABBIT_API_KEY` per `feedback_lag_ops_pat_machine_user` discipline.
- Workflow runs on `pull_request` events; the PR's diff is the input.
- Failures block merge via required-status-check setup (operator adds `cr-precheck` to branch protection in a follow-up).

- [ ] **Step 1: Verify CR CLI works in Linux runner**

Manual verification: spin up a test workflow that just runs the install + version. Verify success before writing the production workflow.

- [ ] **Step 2: Write the workflow**

```yaml
name: CR Precheck
on:
  pull_request:
    types: [opened, synchronize, reopened]
jobs:
  cr-precheck:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # need full history for git diff
      - name: Install CR CLI
        run: |
          curl -fsSL https://cli.coderabbit.ai/install.sh | sh
          echo "$HOME/.local/bin" >> $GITHUB_PATH
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: Run cr-precheck
        env:
          CODERABBIT_API_KEY: ${{ secrets.CODERABBIT_API_KEY }}
        run: |
          node scripts/cr-precheck.mjs --base origin/${{ github.base_ref }}
```

- [ ] **Step 3: Pre-commit grep + canon-audit + commit**

```bash
node ../../scripts/git-as.mjs lag-ceo commit -m "ci(cr-precheck): CI backstop running CR CLI on PR diff"
```

---

## Task 4: `docs/cr-precheck.md` -- operator doc

**Files:**
- Create: `docs/cr-precheck.md`

Content sections: (a) what is cr-precheck, (b) prerequisites (CR CLI installed; on Windows, third-party package), (c) how to run, (d) what skip means, (e) how to query the audit log, (f) CI backstop overview, (g) how to opt into `--strict` if you want medium findings to block too.

Keep it short + linkable. Newcomers find this when CR CLI fails on their machine.

- [ ] **Step 1-5:** Write doc, verify no emdashes, canon-audit, commit.

```bash
node ../../scripts/git-as.mjs lag-ceo commit -m "docs(cr-precheck): operator doc for the pre-push helper + audit + CI backstop"
```

---

## Task 5: Final canon-audit + push + open PR + drive to merge

**Files:** (validation only)

**Security + correctness considerations:**
- This is the FIRST self-test of the helper. After Task 1-4 land, run `node scripts/cr-precheck.mjs` on the full PR diff. If CR CLI is reachable on the operator's machine: catches any findings the implementer missed. If it's NOT reachable: writes a skip atom (this is the dogfood case for the not-found path).
- Per spec §9.3 + canon `dev-implementation-canon-audit-loop`: dispatch a final canon-compliance auditor on the FULL diff before push.
- The bootstrap-exempt carve-out from §9.1 ENDS at this task. From now on, every PR touching this repo runs cr-precheck.

- [ ] **Step 1: Run cr-precheck on the full PR diff**

```bash
node scripts/cr-precheck.mjs --base origin/main
```

Expected outcomes:
- CR CLI reachable on operator's machine → runs review on the cr-precheck PR's own diff (5 commits, ~10 files). Address any critical/major findings; loop until clean.
- CR CLI not reachable in agent worker → writes skip atom. Operator manually validates on their machine before push.

- [ ] **Step 2: Final canon-audit on full diff**

Dispatch canon-audit subagent with full diff + canon + spec. Verify all 4 cross-task invariants:
1. Substrate purity (zero src/ touch)
2. Atom shape consistency (skip + run discriminated by metadata.kind)
3. LOUD-skip discipline (no silent-skip vectors)
4. Spec-implementation alignment

- [ ] **Step 3: Pre-push grep + tests + build**

```bash
grep -rPn $'\u2014' src/ test/ examples/ scripts/ docs/ .github/ 2>&1 | head -3
npm run typecheck && npm run build && npx vitest run
```

All clean + green.

- [ ] **Step 4: Push**

```bash
node ../../scripts/git-as.mjs lag-ceo push origin feat/cr-precheck
```

NEVER `-u`.

- [ ] **Step 5: Open PR**

```bash
node ../../scripts/gh-as.mjs lag-ceo pr create \
  --base main \
  --head feat/cr-precheck \
  --title "feat(cr-precheck): pre-push CR CLI helper + audit + CI backstop (activate dev-coderabbit-cli-pre-push canon)" \
  --body "..."
```

PR body covers: what ships, threat model summary, indie-floor + org-ceiling story, link to the canon directive being activated.

- [ ] **Step 6: Drive to merge**

CR auto-reviews. Address findings via fix-cycle (sub-agent if multiple findings; inline edits if minor). Verify legacy `CodeRabbit` status posts. Verify 0 unresolved threads via GraphQL. Merge via `gh-as lag-ceo pr merge --squash --delete-branch`. Pull main locally.

Update memory: `project_cr_precheck_landed.md`. Mark task #123 complete.

---

## Implementation order

```
Task 1 (helper) ─┬─ Task 2 (audit query)
                 ├─ Task 3 (CI backstop)
                 └─ Task 4 (docs)
                        │
                        └─ Task 5 (validation + push + merge)
```

Tasks 2, 3, 4 are independent of each other after Task 1 lands; can run in parallel under subagent-driven-development.

---

## Notes for implementers

1. **Verify CR CLI v0.4.2 output shape** before implementing the parser in Task 1. Run `coderabbit review --plain` on a small test diff with known findings. The parser MUST match the actual format; if CR CLI's surface differs from public docs, document the deviation in the helper's JSDoc.

2. **Bootstrap-exempt** for Tasks 1-4 (helper doesn't exist yet). Task 5 onwards: every commit touching anything in any LAG repo runs cr-precheck.

3. **CI backstop API key:** Operator MUST add `CODERABBIT_API_KEY` to repo secrets before merging. Document this in the PR body. Without the key, the workflow fails on the API call. (Verify if anonymous mode works for OSS repos; if so, no key needed.)

4. **Worktree path:** all commands assume cwd is `.worktrees/cr-precheck`; `git-as.mjs` and `gh-as.mjs` are at `../../scripts/`.
