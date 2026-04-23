# Pre-push lint

`scripts/pre-push-lint.mjs` runs four narrow rules that CI or CodeRabbit
reliably flag post-push. Running it locally costs ~1s; catching the
same finding via CI or CR costs ~10min plus a review-iteration cycle.

## Run it

```bash
node scripts/pre-push-lint.mjs           # all rules
node scripts/pre-push-lint.mjs --rule=emdash
```

Exit code `0` when clean, `1` with a per-finding report when not.

## Rules

| Rule | What it catches | Gate it mirrors |
|------|-----------------|-----------------|
| `emdash` | `\u2014` (emdash) or `\u2013` (en-dash) in `src/`, `test/`, `docs/`, `design/`, `examples/`, `README.md`. The `fixtures/` directory is excluded for this rule only (mirrors CI's `--exclude-dir=fixtures`). | CI `package hygiene` |
| `private-terms` | Operator-configured deny-list tokens anywhere tracked, **including fixture files** (CI's `git ls-files \| xargs grep` has no fixture exclusion). | CI `package hygiene` |
| `dogfooding-date-prefix` | `docs/dogfooding/*.md` without a `YYYY-MM-DD-` filename prefix | CR convention (first flagged on PR #113) |
| `z-utc-redundant` | A digit followed by `Z`, then one or more whitespace characters, then `UTC`, in `docs/` / `design/` / `README.md` (the `Z` already means UTC per ISO-8601). The regex is `\dZ\s+UTC\b` -- tabs and multi-space runs are matched too, not just a single space. | CR nit (first flagged on PR #115) |

The script is deliberately conservative: rules catch things we have
actually been burned by in review, not hypothetical risks. Adding a
rule requires a failing post-merge grep of `main` to justify it.

### Lint-vs-CI scope divergence is a blocker

Every rule's scope must match its CI counterpart's scope exactly. A
rule that scans less than CI creates a silent miss (the very
~10min-after-push feedback cycle this script is meant to eliminate);
a rule that scans more than CI creates noise the author can't clear
by fixing CI. CodeRabbit caught both shapes on PR #122: `EMDASH_ROOTS`
had dropped `test/` while CI scans it, and `SKIP_DIRS` globally
excluded `fixtures/` while CI's private-terms `git ls-files | xargs
grep` has no such exclusion. Every scope change to either file should
be diffed against the other before merge.

## Wire as a git pre-push hook (optional)

```bash
cat > .git/hooks/pre-push <<'EOF'
#!/usr/bin/env bash
exec node scripts/pre-push-lint.mjs
EOF
chmod +x .git/hooks/pre-push
```

## When the lint is wrong

Two ways a rule produces a false positive:

1. **A file legitimately needs to contain the pattern.** The
   `private-terms` rule mirrors the CI step's self-exclusion list
   (`.github/workflows/ci.yml` and `scripts/pre-push-lint.mjs` itself
   both define the pattern and are excluded). Extend the exclusion set
   with the same rationale if a legitimate case appears.
2. **The rule over-fits.** Relax the regex or scope. Ship the relaxation
   with a regression test under `test/scripts/pre-push-lint.test.ts`
   so the new shape stays covered.
