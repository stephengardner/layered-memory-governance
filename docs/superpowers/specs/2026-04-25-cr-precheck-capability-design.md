# CodeRabbit CLI Pre-Push Capability Design

> **Status:** Draft. Activates the `dev-coderabbit-cli-pre-push` canon directive.

## 0. Future-proofing checklist (per `dev-design-decisions-3-month-review`)

| Canon | How this design satisfies it |
|---|---|
| `dev-coderabbit-cli-pre-push` | Activates the canon by shipping a runnable pre-push helper + audit + CI backstop. Conditional clause "once we have the ability" is now satisfied for environments where CR CLI is installed (Mac/Linux native; Windows via the operator's third-party package). |
| `dev-indie-floor-org-ceiling` | Indie dev without CR CLI installed: PR opens; CI backstop runs CR CLI server-side; merge gate unchanged. Org / operator with CR CLI: catches findings pre-push; PR opens cleaner. Same code path serves both ends. |
| `dev-substrate-not-prescription` | Helper script lives in `scripts/`, not `src/`. The framework substrate is unchanged. Per-actor canon-audit pattern (`dev-implementation-canon-audit-loop`) consumes the helper but does not couple to its implementation. |
| `dev-no-org-shape-in-src` | Zero `src/` touches. The helper is operator-instance tooling, not framework code. |
| `feedback-cr-silent-skip-guards` (memory) | The "not available" path emits a LOUD log message + writes an audit atom. Skips become visible + queryable, not silent. Operator can run `node scripts/cr-precheck-audit.mjs` to list all skips. |
| `dev-no-claude-attribution` | No AI attribution in any committed artifact. |
| `inv-conflict-detection-at-write-time` | Pre-push CR review IS write-time conflict detection (catches issues before the diff hits CR's web review queue). The CI backstop is the safety net for environments that can't run pre-push. |
| `dev-easy-vs-pluggability-tradeoff` | Easy path: hard-require CR CLI on every contributor's machine. Rejected: `dev-indie-floor-org-ceiling` says contributors without CR CLI must still ship. Pluggable path: progressive enhancement at write-time + CI backstop at merge-time. |
| `dev-design-decisions-3-month-review` | If CR ships native Windows binary, the helper transparently picks it up (no code change). If CR's CLI surface evolves, the helper's invocation block isolates the change to one place. If CI runner OS changes, the GHA workflow's install step is the single point of change. |

## 1. Purpose

The `dev-coderabbit-cli-pre-push` canon mandates that PR-authoring agents run CR CLI on their diff before pushing. The canon is conditional on the capability existing in the repo. This design activates that capability via a progressive-enhancement helper script + audit-on-skip + CI backstop.

PR #170 (PrFixActor) shipped three critical findings that a local CR CLI run would have caught in seconds. PR #171 (PR6) shipped through the per-task canon-audit loop with zero critical findings + 12 minor/major. The CR CLI gate complements the canon-audit loop: canon-audit catches operator-specific governance violations; CR CLI catches generic software-quality issues (prototype clobbering, dry-run gaps, hardcoded values, security antipatterns).

## 2. Architectural seam

A single helper script `scripts/cr-precheck.mjs` invoked by PR-authoring agents (or operators) before push. The script is OS-aware, environment-aware, and fail-loud on absence.

### 2.1 What ships

1. `scripts/cr-precheck.mjs` -- the pre-push helper.
2. `scripts/cr-precheck-audit.mjs` -- query-side companion for inspecting recorded skips.
3. `.github/workflows/cr-precheck.yml` -- CI backstop running CR CLI on the merge candidate's diff in a Linux runner.
4. Atom shape: project-scope `observation` atom with `metadata.kind: 'cr-precheck-skip'` + `metadata.cr_precheck_skip: { reason, commit_sha, cwd, os, captured_at }`.
5. Doc page: `docs/cr-precheck.md` -- how to run, what it does, how skips work.
6. Integration with the canon-audit loop's per-task workflow (the auditor sub-agent prompts include "and verify cr-precheck was run on this diff or the skip was recorded").

### 2.2 What does NOT ship

- No `src/` changes. The helper is operator-instance tooling.
- No new substrate atoms. The skip atom uses the generic `observation` type with `metadata.kind` discriminator (matches the PR1 + PR-fix patterns).
- No deprecation of CR's web review. CR web review remains as defense-in-depth + the merge-gate today.

## 3. Components

### 3.1 `scripts/cr-precheck.mjs` -- the pre-push helper

**Inputs:** none (auto-detects diff via `git diff` against the upstream branch). Optional flags:
- `--base <ref>` -- override the comparison base (default: `origin/main` or the upstream branch).
- `--strict` -- fail on `medium` findings too, not just `critical`/`major` (default: critical+major only).
- (no `--no-audit` flag; the audit atom is non-bypassable. Suppressing the audit atom would be a silent-skip vector. Operators who legitimately need to test the helper without writing atoms set `CR_PRECHECK_DRY_RUN=1` at the shell level; the helper logs that the env var is set and exits before the audit-atom write but with a separate `dry-run` log line. A sub-agent dispatched from a clean env cannot set this var without explicit operator action.)
- `--quiet` -- suppress the loud detection log (operator-only; agents MUST NOT pass this).

**Behavior:**

1. **Detect CR CLI.** Look for `coderabbit` or `cr` on PATH. If found:
   - Print `[cr-precheck] found coderabbit at <abs-path> v<version>` (loud, on stderr).
   - Continue to step 2.
   - If NOT found:
   - Print `[cr-precheck] coderabbit NOT FOUND on PATH; canon dev-coderabbit-cli-pre-push expects this run. Skipping local pre-push CR review (CI backstop will run it server-side).` (loud, on stderr).
   - Write the `cr-precheck-skip` audit atom (unless `--no-audit`).
   - Exit 0 (do NOT block the push; progressive enhancement).

2. **Compute diff.** Run `git diff <base>...HEAD` to get the full PR-equivalent diff. If the diff is empty: print `[cr-precheck] no diff vs <base>; nothing to review.` and exit 0 WITHOUT writing any atom (empty diff is not a gate-skip; it's no-op).

3. **Invoke CR CLI.** Run `coderabbit review --plain` (or equivalent invocation per CR CLI v0.4.2 docs) against the working tree. Capture stdout + stderr + exit code. If CR CLI itself errors (non-zero exit before findings parseable, or unrecognized output): print error + write a `cr-precheck-skip` atom with `reason: 'cli-error'` AND exit non-zero (does NOT silently fall through; the gate explicitly catches CLI failures rather than treating them as "review passed").

4. **Parse output.** CR CLI's `--plain` output has a structured shape (verify before implementation). Extract findings classified by severity: `critical`, `major`, `minor`.

5. **Decide.**
   - If 0 critical + 0 major: print summary + exit 0.
   - If any critical or major: print findings + exit non-zero (blocks the push). Operator/agent MUST address before retrying.
   - With `--strict`: also block on `medium`.

6. **Audit on success too.** Write a project-scope `observation` atom with `metadata.kind: 'cr-precheck-run'` + finding counts + commit SHA. The full audit trail captures every push that DID run CR CLI; complements the skip atom.

### 3.2 `scripts/cr-precheck-audit.mjs` -- query helper

Lists recent `cr-precheck-skip` and `cr-precheck-run` atoms, sorted newest-first. Operator runs to see drift:

```bash
node scripts/cr-precheck-audit.mjs --since 24h --kind skip
```

Surfaces every push in the last 24h that bypassed the gate. Catches drift before it becomes culture.

### 3.3 `.github/workflows/cr-precheck.yml` -- CI backstop

GHA workflow:
1. Installs CR CLI via the official `curl ... install.sh` script (Linux runner; CR CLI installs cleanly).
2. Runs `node scripts/cr-precheck.mjs` against the PR's diff.
3. Fails the check on critical/major findings; passes on clean.

This is the merge-gate floor: even contributors whose local environment can't run CR CLI go through this. The workflow is required-status-check-eligible.

CR CLI requires an API key (or anonymous token); the workflow stores it in repo secrets per `feedback_lag_ops_pat_machine_user` discipline (or uses anonymous mode if CR allows it for public repos / OSS use).

### 3.4 Audit atoms

Discriminated by `metadata.kind`. Exactly ONE of the two payload keys is populated per atom; the other is absent.

**Skip atom** (CR CLI not on PATH, or CLI errored, or some other gate-bypass condition):

```ts
{
  type: 'observation',
  layer: 'L0',
  scope: 'project',
  metadata: {
    kind: 'cr-precheck-skip',
    cr_precheck_skip: {
      reason: 'coderabbit-not-on-path' | 'cli-error',
      commit_sha: '<HEAD sha at the moment of skip>',
      cwd: '<absolute path>',
      os: 'win32' | 'linux' | 'darwin',
      cli_error_message?: string,  // set when reason='cli-error'
      captured_at: '<ISO-8601>',
    },
  },
  // ... standard atom envelope
}
```

**Run atom** (CR CLI ran successfully on a non-empty diff):

```ts
{
  type: 'observation',
  layer: 'L0',
  scope: 'project',
  metadata: {
    kind: 'cr-precheck-run',
    cr_precheck_run: {
      commit_sha: '<HEAD sha>',
      findings: { critical: number, major: number, minor: number },
      cli_version: string,  // e.g. '0.4.2'
      duration_ms: number,
      captured_at: '<ISO-8601>',
    },
  },
  // ... standard atom envelope
}
```

Empty-diff runs do NOT write any atom (no-op, not a skip).

The `cr-precheck-audit.mjs` query helper filters by `metadata.kind` to surface skips vs runs cleanly.

### 3.5 Integration with `dev-implementation-canon-audit-loop`

The per-task canon-audit subagent's checklist gains one item:

> **Pre-push gate (per `dev-coderabbit-cli-pre-push`):** verify the implementer ran `node scripts/cr-precheck.mjs` on the task's diff. If the cr-precheck reported any critical/major findings, were they addressed? If the cr-precheck was skipped (CR CLI not available), is the skip atom recorded?

Auditor returns Issues Found if cr-precheck was neither run nor skip-logged. This is how the canon-audit loop enforces the gate without re-running CR CLI itself.

## 4. Data flow

### 4.1 Happy path (operator/agent with CR CLI)

```
agent finishes implementation
  -> agent runs `node scripts/cr-precheck.mjs`
       -> detects coderabbit at /path/to/bin v0.4.2 (LOUD log)
       -> computes git diff origin/main...HEAD
       -> invokes coderabbit review --plain
       -> parses findings
       -> 0 critical/major: prints summary, exits 0; writes cr-precheck-run atom
  -> agent commits + pushes
  -> CI runs cr-precheck.yml as backstop (no-op repeat: same findings, same green)
  -> CR web review on the PR side (defense-in-depth, may catch what CR CLI missed)
```

### 4.2 Skip path (agent without CR CLI)

```
agent finishes implementation in a sub-agent worker without CR CLI
  -> agent runs `node scripts/cr-precheck.mjs`
       -> coderabbit NOT FOUND on PATH (LOUD log: warns canon expects this run)
       -> writes cr-precheck-skip atom (auditable later via cr-precheck-audit.mjs)
       -> exits 0 (does not block)
  -> agent commits + pushes
  -> CI runs cr-precheck.yml as backstop (CR CLI installed in Linux runner; runs review; finds issues if any)
  -> Critical/major findings block CI; PR not mergeable until addressed
  -> CR web review on the PR side
```

### 4.3 Findings path (CR CLI catches issues)

```
agent runs cr-precheck
  -> coderabbit found
  -> findings: 1 critical, 2 major
  -> prints findings (file:line + severity + reason)
  -> exits non-zero
  -> agent's pre-push step fails; agent does NOT push
  -> agent reads the findings, fixes the issues, re-runs cr-precheck
  -> cycle until clean
  -> push proceeds
```

## 5. Threat model + trust contract

### 5.1 What this prevents

- **Critical findings landing in CR web review** (PR #170 pattern: hardcoded operator fallback, prototype clobbering, dry-run gap). Pre-push CR CLI catches these in seconds locally.
- **Silent skips** (CR's 150-file limit pattern from memory `feedback_cr_silent_skip_guards`). Skips here are LOUD: console log + audit atom + queryable via cr-precheck-audit.
- **Agent skipping the gate by accident** (sub-agent dispatched without operator-machine env). The skip is recorded; canon-audit subagent catches it in the per-task workflow.

### 5.2 What this does NOT prevent

- A malicious agent / operator passing `--no-audit` to silence the skip atom. Mitigation: agent flows MUST NOT pass `--no-audit`; only ad-hoc operator-driven runs. The flag is documented as operator-only.
- An attacker who modifies the helper script to no-op. Mitigation: this is repo code; modifications go through the same PR + CR review path.
- CR CLI itself missing a finding. Mitigation: CR web review is defense-in-depth; CR's models improve over time.

### 5.3 Operator trust transfer

The helper writes audit atoms to `.lag/atoms/`. This is the same trust boundary as the rest of `.lag/`. No new exfiltration surface.

CR CLI sends the diff to CR's API for review. This is the same data flow as today's CR web review (which already receives the diff via GitHub webhook). No new data flow.

**Secrets in working tree:** `git diff` only emits committed-tracked file content. Untracked or gitignored files (`.env`, credentials, etc.) never reach CR CLI. This is the same protection git has against the CR web review path; flagged here to confirm it was considered.

## 6. Open architectural decisions

### 6.1 CR CLI invocation surface

Verify before implementation:
- What's the exact CR CLI command? `coderabbit review --plain` is the default per docs. Confirm v0.4.2 supports `--plain` and produces parseable output.
- What's the exit code on findings? Does CR CLI exit non-zero on findings, or always 0?
- What's the parseable format? JSON via `--json`? Plain text via `--plain`?

Implementation must verify by running CR CLI locally on a test diff before writing the parser.

### 6.2 CR CLI authentication

Does CR CLI require an API key (`CODERABBIT_API_KEY` env var or similar)? If yes:
- Local: operator's machine has the key in env or config file (one-time setup).
- CI: stored in repo secrets; injected as env var to the workflow.

### 6.3 Sub-agent worker environments

When PrFixActor or another agent runs in a worker (e.g., a CI runner spawned by `run-pr-fix.mjs`), does the worker have CR CLI? Two paths:
- A. Workers install CR CLI as part of bootstrap. Adds setup cost; reliable.
- B. Workers skip CR CLI; CI backstop catches it. Simpler; loses the speed-up benefit on the agent's own dispatched runs.

**Recommended: B for now.** A can be added later as a per-deployment toggle.

### 6.4 Operator-only `--no-audit` flag

The flag exists for ad-hoc runs (e.g., the operator wants to test the helper without polluting the audit log). Agent flows MUST NOT pass it. Is that enforceable?

**Recommended:** document as "operator-only"; agent runners do not expose the flag. If a malicious sub-agent passes it, the canon-audit reviewer notices the missing skip atom and flags Issues Found.

## 7. Components by file

```
scripts/cr-precheck.mjs                                          # NEW: pre-push helper
scripts/cr-precheck-audit.mjs                                    # NEW: query companion
.github/workflows/cr-precheck.yml                                # NEW: CI backstop
docs/cr-precheck.md                                              # NEW: operator doc
test/scripts/cr-precheck.test.ts                                 # NEW: unit tests
test/scripts/cr-precheck-audit.test.ts                           # NEW
docs/superpowers/specs/2026-04-25-cr-precheck-capability-design.md  # this spec
docs/superpowers/plans/2026-04-25-cr-precheck-capability.md     # the plan
```

## 8. Testing

### 8.1 Unit

- `scripts/cr-precheck.mjs` against stub `which(coderabbit)` returning found / not-found
- Stub `git diff` returning canned diff payload
- Stub `coderabbit review --plain` invocation returning canned findings
- Verify: detection log loud; skip atom written on not-found; run atom written on found; non-zero exit on critical/major; zero exit on clean
- `scripts/cr-precheck-audit.mjs` against MemoryHost with seeded skip + run atoms; verifies query + filter + sort

### 8.2 Integration

End-to-end: real CR CLI installed, real git repo, real diff with intentional finding (e.g., a hardcoded credential). Verify cr-precheck blocks the push.

This test is operator-machine-only (CI runner can't reproduce a "Windows third-party CR CLI" environment); document the manual verification step.

### 8.3 What NOT to test

- CR's actual review accuracy (CR's job).
- The CI workflow's install step (GHA's job; covered by CR's own install script).

## 9. Implementation discipline + pre-flight

### 9.1 Per-task canon-audit (per `dev-implementation-canon-audit-loop`)

Every substantive task in the plan dispatches a canon-compliance auditor sub-agent BEFORE commit. This task ITSELF activates the gate it implements; bootstrapping problem: the helper doesn't exist yet, so we can't run cr-precheck on the implementation tasks. Resolution:
- Tasks 1-N (implementation): canon-audit runs WITHOUT cr-precheck (the gate doesn't exist yet for the gate's own implementation; audit relies on standard discipline).
- Task FINAL (e2e + push): once the helper is committed, the FINAL canon-audit runs cr-precheck on the full diff as the first user of the new gate.

### 9.2 Pre-push gates

1. The helper itself is exempt from "must run cr-precheck" until it's shipped (task 1's commit cannot run a helper that doesn't yet exist).
2. After Task 1 lands, every subsequent task's commit runs `node scripts/cr-precheck.mjs` as a self-test.
3. Standard pre-push grep: emdashes, AI attribution, design refs in src/, PR-phase markers in src/.
4. `npm run typecheck && npm run build && npx vitest run` -- all green.
5. Push via `node scripts/git-as.mjs lag-ceo`. Open PR via `node scripts/gh-as.mjs lag-ceo`.

### 9.3 Final canon-audit before push

Standard cross-task canon-audit on the full diff. Adds one item: verify the helper itself (`scripts/cr-precheck.mjs`) ran on the full diff and reported clean (or any critical/major findings were addressed).

## 10. Open follow-ups (not this PR)

- **CR CLI in dispatched-agent workers**: per §6.3, workers currently rely on CI backstop. Adding bootstrap-side CR CLI install is a follow-up when speed-up benefit on agent's own runs becomes valuable.
- **`coderabbit approve` integration**: CR CLI's `approve` command can clear CR's web-side gate. Useful for the autonomous-merge path; out of scope here.
- **Severity escalation policy**: today the helper blocks on critical+major. As the codebase matures, consider blocking on medium too via `--strict` default. Operator-driven decision.
