# Canon

Canon is the L3 layer of the substrate: human-gated, machine-applied, source of truth. Atoms at L3 render into `CLAUDE.md` targets via `CanonMdManager`; multi-target canon writes one file per scope (org-wide, per-project, per-team, per-agent).

## What canon enforces here

A few representative L3 atoms this repo lives by:

- `dev-simple-surface-deep-architecture`: shallow README, deep substrate. README boots a reader; `docs/` and `design/` carry the load.
- `dev-indie-floor-org-ceiling`: the same substrate that supports a single developer scales to an org without rewrite; config moves, code does not.
- `dev-canon-is-strategic-not-tactical`: refine open plans rather than spawn parallel atoms; widen in place to keep provenance coherent.
- `dev-no-claude-attribution`, `dev-no-operator-real-name-on-automation-artifacts`: automation artifacts wear bot identities; AI authorship attribution does not appear in commits, PRs, comments, or docs.
- `dev-coderabbit-required-status-check-non-negotiable`, `dev-coderabbit-cli-pre-push`: every code-author signed PR runs the CodeRabbit CLI locally before push and gates merge on the CodeRabbit required status.
- `dev-implementation-canon-audit-loop`: writes are preceded by an in-flight canon audit; nothing ships if a public name or PR id is unverified.
- `pol-code-author-signed-pr-only`, `pol-llm-tool-policy-code-author`: only the `code-author` role mutates tracked files in a signed PR.
- `arch-atomstore-source-of-truth`: atoms are the ground truth; everything else is a projection.
- `arch-host-interface-boundary`: the 8-interface Host contract is the governance boundary.
- `arch-actor-message-inbox-primitive`: actor-to-actor coordination is memory governance, not a second substrate.
- `arch-principal-hierarchy-signed-by`: every atom is `signed_by` a principal; depth feeds arbitration.
- `arch-bot-identity-per-actor`: per-role GitHub App identities project the principal hierarchy onto external systems.

## How canon gets applied

`scripts/bootstrap.mjs` seeds invariants as L3 atoms from a root principal and renders them into `CLAUDE.md`. Human edits outside the canon markers are preserved byte-for-byte.

## Output lint as canon enforcement

The package-hygiene CI job verifies no emdashes (U+2014), no AI-attribution markers, and no operator real-name strings in tracked artifacts. Canon stays effective past this PR because the constraint is encoded, not just remembered.

## Reading the live canon

- `CLAUDE.md` at repo root: the rendered L3 view future agents read first.
- `.lag/atoms/`: every atom, including superseded ones, with full provenance chains.
- `DECISIONS.md`: human-readable companion log of architectural choices.
