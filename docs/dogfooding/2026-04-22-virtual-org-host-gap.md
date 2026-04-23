# Task D: memory-Host gap for runCodeAuthor full execution

> Run: 2026-04-22; virtual-org phase 1 + decision-executor on main (commits a208c75 + f8ab3d7)
>
> Companion: [2026-04-22-task-d-132-retro.md](./2026-04-22-task-d-132-retro.md) for the
> full task-D retrospective.

Context: virtual-org bootstrap currently wires `executeDecision` to
`runCodeAuthor` but stops at the observation-only branch because no
`CodeAuthorExecutor` is constructed. On top of that, the memory Host
plus canon fixtures do not satisfy the fence load. The fence-miss is
the first wall; there are four more behind it.

## Chain of responsibility

Decision -> `executeDecision(args)` -> `runCodeAuthor(host, payload, correlationId, options)`
-> (if `options.executor`) `buildDefaultCodeAuthorExecutor(config).execute(...)`
-> `draftCodeChange(host, ...)` -> `applyDraftBranch(...)` -> `createDraftPr(ghClient, ...)`.

## What the memory Host + current boot.mjs provides

- `host.atoms`: `MemoryAtomStore` (in-memory, functional; durable across
  the process only).
- `host.principals`: `MemoryPrincipalStore` (seeded from
  `principals/*.json`).
- `host.clock`: `MemoryClock`.
- `host.canon`, `host.notifier`, `host.scheduler`, `host.auditor`:
  memory stubs (not exercised by the code-author chain).
- `host.llm`: `MemoryLLM` - pre-registered-response stub. Unregistered
  prompts throw `UnsupportedError`. The drafter would hit this on its
  first `host.llm.judge(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, data, ...)`.
- LLM used for deliberation is NOT `host.llm`; `runDeliberation` threads
  a separate `MessagesClient` (CLI subprocess or Anthropic SDK)
  through `anthropic: MessagesClient`. This is adjacent-but-not-wired
  to the drafter.

## What `runCodeAuthor` actually needs (from a clean read of the chain)

1. Fence atoms in `host.atoms` (4 policy atoms the memory Host's seeded
   canon does not ship):
   - `pol-code-author-signed-pr-only`
   - `pol-code-author-per-pr-cost-cap`
   - `pol-code-author-ci-gate`
   - `pol-code-author-write-revocation-on-stop`
   These are seeded from `src/examples/virtual-org-bootstrap/canon/`
   which currently contains only `pol-two-principal-approve-for-l3-merges.json`.
2. A Plan atom in `host.atoms` under the id `executeDecision` passes as
   `plan_id`. The adapter currently passes `decision.id` directly as
   `plan_id`; the store holds the Decision under that id but with
   `type: 'decision'`, not `type: 'plan'`. `runCodeAuthor` demands
   `plan.type === 'plan'` AND `plan.plan_state === 'executing'` - so
   type mismatch is a second wall.
3. A constructed `CodeAuthorExecutor` passed as `options.executor`.
   Without it, `runCodeAuthor` runs the observation-only branch (writes
   one atom, does not invoke drafter/git-ops/pr-creation). Boot.mjs
   does NOT construct one today.
4. If the executor were constructed, `DefaultExecutorConfig` requires:
   - `ghClient: GhClient` - a real `gh api ...` wrapper authenticated
     against the target repo. Not provided by memory Host.
   - `owner`, `repo`, `repoDir` - static config the boot script would
     need to derive or accept via argv.
   - `gitIdentity: GitIdentity` - commit author/committer name + email
     (typically `lag-ceo[bot]`).
   - `model: string` - model name for drafter.
   - `execImpl: typeof execa` - optional, defaults to real `execa`,
     which runs real `git fetch/apply/commit/push`. Acceptable in a
     worktree; pointed at the real repo dir.
5. A real LLM bound to `host.llm` that `draftCodeChange` can call. The
   drafter uses `host.llm.judge(DRAFT_SCHEMA, ...)` with a JSON schema.
   The Anthropic SDK + an API key would satisfy this; the CLI client
   (what the bootstrap defaults to) is a `MessagesClient`, not
   an `LLM` - different interface.

## Minimum Host to make full execution work

A composite host that swaps four memory pieces for real-or-seeded ones:

1. **File-backed or seeded AtomStore** - seed the 4 missing `pol-*`
   fence atoms into canon fixtures OR mutate `host.atoms` after
   construction, before `executeDecision`. `createFileHost` exists and
   would make this durable.
2. **Plan-atom materializer** - between Decision and `executeDecision`
   call, synthesize a `type: 'plan'`, `plan_state: 'executing'` atom
   under the id the adapter will pass as `plan_id`. 30 LOC wrapper.
3. **Real LLM binding for `host.llm`** - swap `MemoryLLM` for a real
   adapter. Candidates:
   - Anthropic SDK adapter (`@anthropic-ai/sdk`) - exists in
     `src/adapters/` already? (need to verify) - requires API key.
   - CLI-backed `LLM` adapter - requires lifting a `judge`-shape
     function over the CLI client. Not trivial; the CLI streams, does
     not emit a JSON-schema-validated response natively. Achievable
     with a schema-validation pass on the CLI's structured-output
     block.
4. **`GhClient` + `GitIdentity`** - use the existing `gh-as` wrapper as
   the backend for `GhClient`; git identity = `lag-ceo[bot]`. The
   current `scripts/gh-as.mjs` already mints short-lived tokens for
   the role; a GhClient could shell out through it.
5. **`buildDefaultCodeAuthorExecutor(config)` construction** - 20 LOC
   in boot.mjs that builds the config from the seeded atoms +
   environment and passes it to `executeDecision` through the
   `codeAuthorFn` option (or, lighter, inject a wrapper `codeAuthorFn`
   that re-calls `runCodeAuthor` with the executor attached).

## Estimated scope

- Canon fixtures for 4 missing `pol-*` atoms: 4 files, ~2h (atom
  shape is well-defined).
- Plan-atom materializer: ~30 LOC, 1h.
- `host.llm` real binding using Anthropic SDK: ~1 day if an adapter
  already exists; ~2 days if we need to write + unit-test one.
  CLI-backed `LLM.judge` is ~3 days because schema-validation
  of the CLI output is its own design question.
- `GhClient` -> `gh-as` wrapper: ~1 day including tests against a
  sandbox repo.
- Boot wiring to construct executor + thread through: ~1 day with
  integration test.

Total: 3-5 eng days for a minimum end-to-end path. Probably right-sized
for a phase-2 sprint.

## Recommendation

The memory Host is correct for its job (fast, deterministic
deliberation + assertion surface); it is not the right seam for real
PR production. A phase-2 "hosted virtual-org" adapter is the natural
home for the 5 pieces above. Keep memory as the default for local
smoke tests and e2e vitest; introduce a new `createRealHost` (or
composite builder) for the path that actually ships PRs.
