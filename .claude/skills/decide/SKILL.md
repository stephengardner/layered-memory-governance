---
name: decide
description: Capture an operator-stated directive, decision, or preference as an L3 canon atom so future agents inherit it via the canon store. Use when the operator makes a governance call ("CR is non-negotiable", "no real-name comments on automation PRs", "always X when Y") that should persist across sessions rather than live only in this chat transcript.
---

# decide: atomize operator directives into canon

The gap this skill closes: operator-stated directives in chat stay in chat. Fresh agents next session do not see them. Without a deliberate capture step, session preference drifts, the operator re-states the same constraint, and LAG's "memory is the foundation" story has a hole exactly where operator will meets the codebase.

## When to invoke

Trigger when the operator has made a governance-shaped statement that should outlast this session:

- Hard constraints: "CR is non-negotiable", "no real-name comments on automation artifacts", "merges always flow through lag-ceo"
- Decisions with rationale: "we chose B over A because..."
- Preferences: "prefer small PRs over monoliths for this repo"
- References: "our auth service is in the ACME repo, see <link>"

Do NOT invoke for:

- Session-local task plans (use `TodoWrite`/tasks instead)
- Ephemeral questions ("what's the PR number")
- Things already covered by existing canon atoms (query first, reuse)

## Shape of the atom

Every atom this skill produces MUST satisfy:

- `id`: kebab-case, `<type-prefix>-<topic>` shape. Prefixes: `dev-` for directives, `dec-` for decisions, `pref-` for preferences, `ref-` for references.
- `type`: one of `directive | decision | preference | reference`.
- `content`: canon-quality prose, >= 20 chars. Direct, declarative, no hedging. Reads as something a future agent can act on.
- `alternatives_rejected`: array of `{option, reason}`. Non-reference atoms MUST list >= 1 alternative per `dev-extreme-rigor-and-research`. A decision without rejected alternatives is a preference without rigor; require the operator to name what they considered.
- `what_breaks_if_revisited`: one sentence per `dev-forward-thinking-no-regrets`. Answers: "in 3 months, what about today's context makes this sound or regret-worthy?"
- `derived_from`: array of atom ids this directive builds on (may be empty for genuinely new ground).

## How to drive the capture

**Step 1 - extract structure from operator language.** The operator rarely says "alternatives I rejected were..." out loud. The skill's job is to make the implicit explicit:

- Read back the stated directive in plain English for confirmation.
- Ask: "what alternatives did you consider before landing on this?" (operator may need 1-2 prompts to surface them)
- Ask: "in 3 months, what would make us regret this? or: what about today's context makes it sound?"
- Pick the atom id based on the directive's shape.

**Step 2 - write a spec JSON.** Either as a file or piped via stdin. Shape matches `scripts/decide.mjs`:

```json
{
  "id": "dev-coderabbit-required-status-check-non-negotiable",
  "type": "directive",
  "content": "CodeRabbit is a required status check for main... (canon-quality prose)",
  "alternatives_rejected": [
    { "option": "Drop CR from required checks for bot-opened PRs", "reason": "loses the merge gate for exactly the PRs most in need of it" },
    { "option": "Path-scoped conditional via ruleset", "reason": "still removes the gate for some PRs; gate-weakening by class" }
  ],
  "what_breaks_if_revisited": "Merge quality gate weakens; CR findings become advisory only.",
  "derived_from": ["inv-governance-before-autonomy"]
}
```

**Step 3 - invoke the CLI.**

```bash
node scripts/decide.mjs --spec-file /tmp/directive-spec.json
```

Or flag-composed for quick captures:

```bash
node scripts/decide.mjs \
  --id dev-foo \
  --type directive \
  --content "..." \
  --alternative "A::rejected because X" \
  --alternative "B::rejected because Y" \
  --what-breaks "One-sentence answer"
```

**Step 4 - idempotency handling.** The script is idempotent per id:

- No existing atom -> writes, prints new atom id.
- Same spec as stored -> no-op, prints "no drift".
- Changed spec vs stored -> fails loud with a diff list. Operator decides: reconcile the spec with stored, OR supersede by picking a new id + marking the old one canon-promoted.

## Principals + authority

The atom is written with `principal_id=$LAG_OPERATOR_ID` and `provenance.kind=human-asserted`. Operator has signing authority for L3 canon by definition; `/decide` captures that authority in the atom itself so arbitration can use the principal-hierarchy-depth signal later.

If `LAG_OPERATOR_ID` is unset, the script exits with a clear error. Set it in your shell profile or in the session:

```bash
export LAG_OPERATOR_ID=apex-agent   # whatever your operator principal id is
```

## Discipline notes

- **Prefer atomization in-the-moment over batch-capture later.** The operator's precise framing decays fast; an atom written 30 seconds after the statement reads like the statement. An atom written a week later reads like a reconstruction.
- **Cite your derived_from.** Even a genuinely new directive usually builds on an existing invariant (`inv-*`) or architectural decision (`arch-*`). The chain is load-bearing for future conflict arbitration.
- **One atom per directive.** Resist bundling. "CR is required AND real-name comments are forbidden" is two atoms, not one.
- **Don't paraphrase operator rationale.** If the operator said "because [specific reason]", the atom's content should carry that exact reason. Softening the language for "canon tone" is a loss.
