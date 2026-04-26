> Status (as of PR #172, on main): the CR CLI pre-push helper at `scripts/cr-precheck.mjs` is progressive-enhancement (skips with a loud warning + audit atom when the CR CLI is not on PATH); when the CLI is present, the gate blocks on critical/major findings (use `--strict` to also block on minor); the hard merge gate is the CI workflow at `.github/workflows/cr-precheck.yml` running the same checks server-side as a required status check.

# cr-precheck: pre-push CodeRabbit-CLI helper

## What is cr-precheck

`scripts/cr-precheck.mjs` is a progressive-enhancement pre-push helper. It detects whether the CodeRabbit CLI is on PATH; if found, it runs `coderabbit review` against the local diff and blocks the push on critical or major findings. If not found, it logs a LOUD warning, writes a `cr-precheck-skip` audit atom, and exits 0 so the push is not blocked. The CI workflow at `.github/workflows/cr-precheck.yml` is the merge-time backstop that runs CR CLI server-side regardless of the contributor's local environment.

## Prerequisites

- CodeRabbit CLI v0.4.2 or newer:
  - macOS / Linux: official install via `curl -fsSL https://cli.coderabbit.ai/install.sh | sh` (drops `coderabbit` and a `cr` alias into `~/.local/bin`).
  - Windows: install via the operator's third-party package; the helper resolves the binary through `PATH` and `PATHEXT`, so any extension landing on PATH works (`coderabbit.exe`, `coderabbit.cmd`, etc).
- API key: `CODERABBIT_API_KEY` env var, or run `coderabbit auth login` once to persist it.
- Node 22+ and a built `dist/` (`npm run build`) so the helper can import the file-host adapter to write audit atoms.

## How to run

```bash
node scripts/cr-precheck.mjs
node scripts/cr-precheck.mjs --base origin/dev
node scripts/cr-precheck.mjs --strict
CR_PRECHECK_DRY_RUN=1 node scripts/cr-precheck.mjs
```

- Default base is `origin/main`. Override with `--base <ref>` when stacking off another branch.
- Default gate fires on critical and major findings only. `--strict` adds minor findings to the block list.
- Exit codes: `0` clean (or skipped on not-found, or empty diff), `1` findings present (or CR CLI errored), `2` bad arguments OR an uncaught exception bubbled out of `main()` in `scripts/cr-precheck.mjs` (e.g., unexpected runtime error, atom-write crash before the gate decision).

## What "skip" means

Two skip conditions are recognized. Both are LOUD: a stderr line names the condition, and a `cr-precheck-skip` audit atom is written to `.lag/atoms/` (project scope, `metadata.kind = 'cr-precheck-skip'`).

- `coderabbit-not-on-path`: the CLI is not installed on this machine. The helper logs the warning, writes the atom, and exits 0. The push proceeds; the CI backstop catches review issues at merge time.
- `cli-error`: the CLI is installed but failed (auth error, network error, transient runtime fault). The helper logs the error, writes the atom, and exits 1, which blocks the push. Re-run after fixing the underlying error.

Empty diffs are no-ops: nothing to review, no atom written.

## Querying the audit log

`scripts/cr-precheck-audit.mjs` lists `cr-precheck-skip` and `cr-precheck-run` atoms newest-first. Use it to spot drift before it becomes culture.

```bash
node scripts/cr-precheck-audit.mjs
node scripts/cr-precheck-audit.mjs --since 24h
node scripts/cr-precheck-audit.mjs --since 7d --kind skip
node scripts/cr-precheck-audit.mjs --kind run --limit 200
```

Flags:

- `--since <duration>`: filter to atoms within the window. Suffixes `s`, `m`, `h`, `d`, `y`. Typos fail closed (the parser does not silently widen).
- `--kind skip|run|all`: filter by atom kind. Default `all`.
- `--limit <n>`: row cap. Default 50.

Output is one row per atom:

```
2026-04-25T14:02:11.420Z  skip   coderabbit-not-on-path   3876206  os=win32
2026-04-25T13:55:08.110Z  run    c=0 m=0 n=2              ffaa54d  v0.4.2
```

## CI backstop

`.github/workflows/cr-precheck.yml` runs on every `pull_request` event in a Linux runner:

1. Checks out with full history (`fetch-depth: 0`) so `git diff origin/<base>...HEAD` resolves both endpoints.
2. Installs deps with `npm ci --ignore-scripts` and runs `npm run build`.
3. Installs CR CLI via the official `install.sh`.
4. Runs `node scripts/cr-precheck.mjs --base "origin/${{ github.base_ref }}"`.

Operator setup: add `CODERABBIT_API_KEY` to the repo secrets. Without it, the workflow emits a loud `::warning::` and skips the install/verify/review steps (exit success), so the gate is inert-but-honest until the secret lands. Anonymous mode is not assumed available; if CR ships OSS-anonymous later, the secret requirement can be relaxed.

Once the secret is configured, the `cr-precheck` job is required-status-check eligible. Add it to branch protection AFTER the secret lands; adding it earlier turns the gate into a green-by-default no-op (the silent-skip antipattern this helper is meant to prevent).

## Troubleshooting

- "coderabbit NOT FOUND on PATH": install the CLI per Prerequisites above, or proceed with the push and rely on the CI backstop. The helper exits 0 so this is never a hard block locally.
- "coderabbit exited <n>; treating as cli-error": run `coderabbit --version` directly to confirm the install. Authentication errors usually mean `CODERABBIT_API_KEY` is unset or expired; re-run `coderabbit auth login`.
- Helper crashes inside `createFileHost`: run `npm run build`. The audit-atom path imports from `dist/adapters/file/index.js`, which only exists after a build.
- `git diff failed against origin/main`: make sure the base ref is fetched (`git fetch origin main`), or pass `--base <ref>` with a ref that exists locally.
- Test the helper without polluting the audit log: set `CR_PRECHECK_DRY_RUN=1`. The helper logs the dry-run mode and skips the atom write. Agent flows MUST NOT set this var; it is operator-only.

## Canon reference

- `dev-coderabbit-cli-pre-push`: the canon directive this helper activates. Conditional on the capability existing in the repo; once cr-precheck shipped, the directive is live for environments where CR CLI is reachable.
- `feedback-cr-silent-skip-guards`: the antipattern this helper avoids. CR's silent thresholds (e.g., 150-file limit) suppress reviews without operator-visible signal. The skip-atom plus stderr warning here makes every gate-bypass auditable.
