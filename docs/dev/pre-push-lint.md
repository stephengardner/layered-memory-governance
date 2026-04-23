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
| `emdash` | `\u2014` (emdash) or `\u2013` (en-dash) in `src/`, `docs/`, `design/`, `examples/`, `README.md` | CI `package hygiene` |
| `private-terms` | Operator-configured deny-list tokens anywhere tracked | CI `package hygiene` |
| `dogfooding-date-prefix` | `docs/dogfooding/*.md` without a `YYYY-MM-DD-` filename prefix | CR convention (first flagged on PR #113) |
| `z-utc-redundant` | `<digit>Z<space>UTC` in docs (the `Z` already means UTC per ISO-8601) | CR nit (first flagged on PR #115) |

The script is deliberately conservative: rules catch things we have
actually been burned by in review, not hypothetical risks. Adding a
rule requires a failing post-merge grep of `main` to justify it.

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
