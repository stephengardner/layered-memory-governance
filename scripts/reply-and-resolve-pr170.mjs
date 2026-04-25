#!/usr/bin/env node
// Reply inline to each CR thread on PR #170 and resolve it. Reads GH_TOKEN
// from env. Per canon `feedback_detailed_coderabbit_replies`, each reply
// covers what changed (commit SHA + brief), why (rationale + trade-offs),
// and edge cases or follow-ups, BEFORE resolving.
import { execSync } from 'node:child_process';

const threads = [
  // ---- Finding 1 -------------------------------------------------------
  {
    id: 'PRRT_kwDOSGhm9859mZ0d',
    label: 'F1 (Critical) bootstrap-pr-fix-canon.mjs:121 -- hardcoded stephen-human fallback',
    body:
      'Fixed in bd8e7ed.\n\n'
      + '**What changed:** dropped both `|| \'stephen-human\'` fallbacks. The '
      + 'script now reads `process.env.LAG_OPERATOR_ID` exactly once at module '
      + 'top; if it is undefined or empty, the script prints an actionable '
      + 'error pointing at the env var and exits 2 (matching '
      + '`bootstrap-code-author-canon.mjs` and `bootstrap-inbox-canon.mjs`).\n\n'
      + '**Why:** pr-fix-actor dispatches sub-agent loops that write to a '
      + 'shared repo. A silent default would attribute six L3 policy atoms '
      + 'to a sentinel id that may not exist in this repo, silently forking '
      + 'the authority chain and making the policy-payload provenance '
      + 'unverifiable on a fresh deployment. Fail-fast at bootstrap is the '
      + 'cheapest enforcement point; once .lag/atoms/ is trusted, runtime '
      + 'tooling cannot retroactively repair the swap.\n\n'
      + '**Kept as-is:** `LAG_AGENT_ID || \'claude-agent\'` (per CR\'s own '
      + 'guidance and matching the other bootstrap scripts). The risk this '
      + 'soft fallback could create is closed by the parent-chain drift '
      + 'check (Finding 2): a tampered claude-agent fails loud rather than '
      + 'being silently inherited as pr-fix-actor.signed_by.\n\n'
      + '**Edge case:** the env-var check uses `length === 0` so an '
      + 'accidental `LAG_OPERATOR_ID=` (empty string) still trips the gate, '
      + 'not just the unset case.',
  },
  // ---- Finding 2 -------------------------------------------------------
  {
    id: 'PRRT_kwDOSGhm9859mZ0h',
    label: 'F2 (Major) bootstrap-pr-fix-canon.mjs:219 -- principal writes have no drift guard',
    body:
      'Fixed in bd8e7ed.\n\n'
      + '**What changed:** mirrored the parent-chain drift pattern from '
      + '`bootstrap-code-author-canon.mjs`:\n'
      + '- New `ensureParentChain()`: fetches operator + claude-agent, seeds '
      + 'when missing, drift-checks (via new `diffPrincipal()`) when '
      + 'present. Drift on `name`, `role`, `signed_by`, `active`, '
      + '`compromised_at`, `permitted_scopes`, or `permitted_layers` exits '
      + '1 with the field-level diff before any pr-fix-actor write.\n'
      + '- pr-fix-actor write itself was unconditional `put()`. It is now '
      + 'gated: get -> if missing put, if present diff -> exit on mismatch. '
      + 'Operator-curated edits to goals/constraints/permitted_layers are '
      + 'preserved across re-runs.\n\n'
      + '**Why:** the silent-re-attribution class this fence atoms exist '
      + 'to close, applied one hop up. If the parent is tampered, the write '
      + 'that inherits from it is already suspect; pr-fix-actor cannot '
      + 'safely inherit a signed_by edge to a drifted parent. '
      + '`compromised_at` drift is specifically load-bearing because a '
      + 'cleared compromised_at under a rotated key (or a non-null value '
      + 'on the canonical key) is exactly the silent-re-attribution shape '
      + 'this check catches.\n\n'
      + '**Edge case:** the actor principal\'s drift check uses the same '
      + '`diffPrincipal()` shared with the parent chain, so if an operator '
      + 'manually edits .lag/principals/pr-fix-actor.json (e.g. to relax '
      + '`permitted_layers.write` to include L2), the next bootstrap run '
      + 'fails loud rather than silently reverting the relaxation. Operator '
      + 'must edit the script\'s `prFixActorPrincipal()` to match if the '
      + 'edit is authoritative, or revoke through an operator tool before '
      + 're-bootstrapping.\n\n'
      + '**Follow-up:** future bootstrap scripts should mirror this same '
      + '`ensureParentChain` shape (cto-actor, pr-landing, master '
      + 'bootstrap). Out of scope here; tracking via the recurring CR '
      + 'pre-submit checklist (canon: '
      + '`feedback_cr_recurring_pattern_presubmit_checklist`).',
  },
  // ---- Finding 3 -------------------------------------------------------
  {
    id: 'PRRT_kwDOSGhm9859mZ0j',
    label: 'F3 (Major) bootstrap-pr-fix-canon.mjs:231 -- idempotency check is id-only',
    body:
      'Fixed in bd8e7ed.\n\n'
      + '**What changed:** lifted the `diffPolicyAtom` shape from '
      + '`bootstrap-inbox-canon.mjs`. The POLICIES loop now: get -> if '
      + 'missing put, if present run the diff. The diff covers:\n'
      + '- shape: `type`, `layer`, `content`\n'
      + '- identity: `principal_id`\n'
      + '- provenance integrity: `provenance.kind`, '
      + '`JSON.stringify(provenance.source)`, `provenance.derived_from`\n'
      + '- payload: every key in `metadata.policy.{action, priority, '
      + 'reason, tool, subject, origin, principal}`, with the union of '
      + 'stored + expected key-sets so a stripped key (e.g. expected '
      + 'priority=10 but stored omits priority entirely) is loud.\n\n'
      + '**Why:** the four integrity fields (principal_id + the three '
      + 'provenance sub-fields) are exactly the surface where a silent '
      + 're-attribution can hide under unchanged numeric thresholds. '
      + 'A compromised principal could quietly re-sign the policy table '
      + 'without changing any operational behavior, and the substrate '
      + 'has no other cheap point to detect that. Bootstrap is the only '
      + 'place where this catches before .lag/atoms/ is trusted.\n\n'
      + '**Edge case:** drift exits 1 with the field-level descriptor '
      + 'list (e.g. `[bootstrap-pr-fix] DRIFT on pol-pr-fix-default-deny: '
      + 'policy.priority: stored=5 expected=0`). Operator can resolve by '
      + '(a) editing POLICIES[] if stored is authoritative, or (b) '
      + 'bumping the atom id and superseding the old one if the policy '
      + 'change is intentional.\n\n'
      + '**Trade-off:** the diff is strict by design. If we want a '
      + 'looser "skip on identical id; warn on tampered fields" mode '
      + 'later, that is an operator-controlled flag, not a default. '
      + 'Default-strict matches the discipline of bootstrap-inbox-canon '
      + 'and bootstrap-code-author-canon.',
  },
  // ---- Finding 4 -------------------------------------------------------
  {
    id: 'PRRT_kwDOSGhm9859mZ0l',
    label: 'F4 (Critical) run-pr-fix.mjs:175 -- withAdapterIdentity clobbers prototypes',
    body:
      'Fixed in bd8e7ed via your suggested diff.\n\n'
      + '**What changed:** `withAdapterIdentity` now uses '
      + '`Object.assign(Object.create(Object.getPrototypeOf(adapter)), '
      + 'adapter, { name, version })`. Prototype chain is preserved + own '
      + 'enumerable properties copied + identity fields layered on top.\n\n'
      + '**Why this is a runtime crasher:** the four substrate primitives '
      + '(`ClaudeCodeAgentLoopAdapter`, `GitWorktreeProvider`, '
      + '`FileBlobStore`, `RegexRedactor`) are class-backed; methods like '
      + '`run()`, `acquire()`, `release()`, `redact()` live on the '
      + 'prototype, not as own properties. The plain spread `{ ...adapter, '
      + 'name, version }` would copy zero of those methods and the very '
      + 'first call (`ctx.adapters.agentLoop.run(...)` inside '
      + '`PrFixActor.apply()`) would throw "agentLoop.run is not a '
      + 'function". Same crash for `workspaceProvider.acquire/release` and '
      + '`blobStore.put/get`.\n\n'
      + '**Why this slipped through tests:** the test suite stubs all '
      + 'four adapters with plain object literals (test/runtime/actors/'
      + 'pr-fix/pr-fix.test.ts), where own properties + the spread '
      + 'happen to align. The crash only surfaces against a real '
      + 'class-backed adapter -- which is exactly the path the driver '
      + 'script wires.\n\n'
      + '**Trade-off vs operator alternatives:** considered (a) mutating '
      + 'the adapter directly via `adapter.name = name` -- rejected: the '
      + 'wrap is meant to be non-mutating per the original JSDoc, and '
      + 'mutation would couple two consumers if a future caller wraps '
      + 'the same instance twice; (b) `Object.defineProperties(adapter, '
      + '{...})` -- equivalent shape but mutating; (c) the '
      + '`Object.create(getPrototypeOf)` form -- chosen because it '
      + 'matches the single-pass non-mutating contract the JSDoc '
      + 'documented while preserving prototype.\n\n'
      + '**Edge case:** for adapters that are plain object literals (no '
      + 'prototype methods, just own properties), `getPrototypeOf` '
      + 'returns `Object.prototype` and `Object.create` produces a fresh '
      + 'object inheriting from `Object`; `Object.assign` then copies '
      + 'own props, then identity fields. Behavior is identical to the '
      + 'old spread for that case. So this is strictly additive: works '
      + 'for both class-backed and plain-object adapters.',
  },
  // ---- Finding 5 -------------------------------------------------------
  {
    id: 'PRRT_kwDOSGhm9859mZ0r',
    label: 'F5 (Critical) run-pr-fix.mjs:241 -- --dry-run does not enforce read-only',
    body:
      'Fixed in bd8e7ed.\n\n'
      + '**What changed:** the driver now passes '
      + '`additionalDisallowedTools: args.live ? [] : [\'Bash\']` into '
      + '`PrFixActor`. In dry-run mode, the spawned sub-agent\'s tool '
      + 'policy gates Bash, so the agent cannot shell out to `git push`, '
      + '`gh pr edit`, or any other write.\n\n'
      + '**Why this is at the actor / driver layer, not the adapter '
      + 'layer:** the substrate primitives (`FileBlobStore`, '
      + '`GitWorktreeProvider`, `ClaudeCodeAgentLoopAdapter`) are '
      + 'dry-run-agnostic by design; their interfaces have no '
      + '`{dryRun}` field because at the substrate level a workspace is '
      + 'a workspace and a blob is a blob. The right place to enforce '
      + 'the operator-controlled read-only contract is the agent\'s '
      + 'tool policy -- the layer where "Bash" is a discoverable, '
      + 'overridable surface. The actor\'s '
      + '`SUB_AGENT_DISALLOWED_FLOOR` (`WebFetch`, `WebSearch`, '
      + '`NotebookEdit`) is sized for substrate-level write paths the '
      + 'operator never wants regardless; Bash is the one that switches '
      + 'between dry-run and live.\n\n'
      + '**Why not a Bash-deny in the FLOOR:** would break live mode '
      + '(operators legitimately need shell access for `git commit` / '
      + '`git push` in live mode). Toggling FLOOR per-call would couple '
      + 'the substrate floor to driver state; cleaner to keep FLOOR '
      + 'static and let the driver layer the operator-mode flag on top '
      + 'via `additionalDisallowedTools`.\n\n'
      + '**Edge case:** the live path passes `[]` (no override), '
      + 'preserving the existing per-deployment surface. A future '
      + 'operator who wants Bash gated even in live mode for a stricter '
      + 'posture can wire it via the canon policy table or a future '
      + '`--no-bash` flag without re-touching this code path.',
  },
  // ---- Finding 6 -------------------------------------------------------
  {
    id: 'PRRT_kwDOSGhm9859mZ0u',
    label: 'F6 (Major) pr-fix.ts:249 -- stale classification + missing session linkage',
    body:
      'Fixed in 919888c.\n\n'
      + '**What changed:**\n'
      + '- `classify()` now patches '
      + '`metadata.pr_fix_observation.classification` with the actually-'
      + 'computed value via `host.atoms.update()`. observe() still writes '
      + 'a placeholder `\'has-findings\'` so the atom always has a '
      + 'discriminator field, but classify\'s patch overwrites that '
      + 'placeholder with the real value (clean / has-findings / '
      + 'ci-failure / architectural / partial).\n'
      + '- `apply()` now patches '
      + '`metadata.pr_fix_observation.dispatched_session_atom_id` with '
      + 'the agent-loop\'s sessionAtomId after a fix-pushed outcome. The '
      + 'audit trail chains observation -> session -> turn atoms.\n\n'
      + '**Important note on update() merge semantics:** verified '
      + 'against `src/adapters/file/atom-store.ts:129-131` and '
      + '`src/adapters/memory/atom-store.ts:116-118` -- both shallow-'
      + 'merge metadata via `{ ...existing.metadata, ...patch.metadata '
      + '}`. So a naive `metadata: { pr_fix_observation: { '
      + 'classification } }` patch would CLOBBER any sibling fields '
      + '(the prior dispatched_session_atom_id, partial flag, '
      + 'cr_review_states, etc.). The fix reads existing.metadata.'
      + 'pr_fix_observation, spreads it into the patch, and overrides '
      + 'only the field being changed, so the merge is effectively '
      + 'deep-key-by-key.\n\n'
      + '**Why patch failure is non-fatal in both call sites:** the '
      + 'in-memory return value (Classified / PrFixOutcome) is the '
      + 'correctness primitive; the persisted-atom side effect is '
      + 'forensic convenience. A transient store error must not mask '
      + 'an upstream success. Both patch sites are wrapped in '
      + 'try/catch with an explicit "swallow with rationale" comment.\n\n'
      + '**Edge case:** classify\'s patch only fires when the new '
      + 'classification differs from the stored one. observe() writes '
      + '`\'has-findings\'` placeholder unconditionally, so the patch '
      + 'fires on the first iteration whenever the real outcome is '
      + 'anything other than has-findings. On subsequent iterations '
      + 'where classify computes the same classification as observe '
      + 'wrote, the patch is skipped (zero IO).\n\n'
      + '**Edge case 2:** apply\'s patch happens after the resolveComment '
      + 'loop and before the function returns, but inside the try/finally '
      + 'so the workspace release still runs even if the patch throws.',
  },
  // ---- Finding 7 -------------------------------------------------------
  {
    id: 'PRRT_kwDOSGhm9859mZ0x',
    label: 'F7 (Major) pr-fix.ts:573 -- aborted result not preserved',
    body:
      'Fixed in 919888c via your suggested diff.\n\n'
      + '**What changed:** added a special-case for `agentResult.kind '
      + '=== \'aborted\'` BEFORE the generic non-completed branch:\n\n'
      + '```ts\n'
      + 'if (agentResult.kind === \'aborted\') {\n'
      + '  const err = new Error(\'agent loop aborted\');\n'
      + '  err.name = \'AbortError\';\n'
      + '  throw err;\n'
      + '}\n'
      + 'if (agentResult.kind !== \'completed\') {\n'
      + '  // existing fix-failed mapping...\n'
      + '}\n'
      + '```\n\n'
      + '**Why thrown not returned:** the substrate vocabulary '
      + 'distinguishes "no progress this iteration" (fix-failed -> '
      + 'reflect maps to progress: false -> runActor convergence-loop '
      + 'eventually halts) from "halt now" (kill-switch / deadline / '
      + 'caller cancellation). Aborted is the latter. Returning '
      + '`{kind: \'fix-failed\'}` would feed convergence handling and '
      + 'trigger another iteration of observe -> classify -> propose, '
      + 'which is the exact wrong behavior for a kill-switch trip. '
      + 'Throwing AbortError unwinds through runActor\'s kill-switch '
      + 'unwind path so the actor halts immediately.\n\n'
      + '**Why the AbortError name and not just any Error:** runActor '
      + 'classifies thrown errors and treats `err.name === '
      + '\'AbortError\'` as a cooperative halt distinct from a crash. '
      + 'Without the name, the throw would land in the actor-crashed '
      + 'reportcode path (exit-code 1) instead of the converged-or-'
      + 'halted path (exit-code 0).\n\n'
      + '**Edge case:** the workspace release in the `finally` block '
      + 'still runs because the throw is inside the `try`. So aborts '
      + 'do not leak the worktree.',
  },
  // ---- Finding 8 -------------------------------------------------------
  {
    id: 'PRRT_kwDOSGhm9859mZ0y',
    label: 'F8 (Major) substrate/types.ts:122 -- pr-fix-observation atom type lives in substrate',
    body:
      'Fixed in cdf1b33. **This is the architectural revert; called '
      + 'out as the most important fix in the round.**\n\n'
      + '**What changed (5 edits, 1 logical commit):**\n'
      + '1. `PrFixObservationMeta` interface MOVED from '
      + '`src/substrate/types.ts` to '
      + '`src/runtime/actors/pr-fix/types.ts`. JSDoc rewritten in '
      + 'mechanism-neutral language (drops "GitHub PR snapshot" -> '
      + '"PR snapshot"; drops the actor-method-name references).\n'
      + '2. `\'pr-fix-observation\'` REMOVED from the `AtomType` union. '
      + 'The comment block referencing PrFixActor.observe / apply / '
      + 'host.atoms.update is gone (it violated the mechanism-only '
      + 'comment rule by naming actor methods + control flow).\n'
      + '3. Removed from `DEFAULT_HALF_LIVES` in '
      + '`src/runtime/loop/types.ts` (no longer needed; observation '
      + 'is the union member that carries the half-life now).\n'
      + '4. Removed from `TYPE_ORDER` and `TYPE_HEADINGS` in '
      + '`src/substrate/canon-md/generator.ts`.\n'
      + '5. `mkPrFixObservationAtom` now writes `type: \'observation\'` '
      + 'with `metadata.kind: \'pr-fix-observation\'` as the '
      + 'discriminator. metadata structure: `{ kind: '
      + '\'pr-fix-observation\', pr_fix_observation: m }`. Mirrors the '
      + 'sibling pr-landing actor exactly (which uses '
      + '`metadata.kind: \'pr-observation\'`).\n\n'
      + '**Plus test updates:**\n'
      + '- test/substrate/atom-types.test.ts drops the pr-fix-'
      + 'observation block (those types are no longer in substrate).\n'
      + '- test/runtime/actors/pr-fix/pr-fix.test.ts updates '
      + 'assertions: `type === \'observation\'` AND `metadata.kind === '
      + '\'pr-fix-observation\'`. The e2e query at L1365 was '
      + '`{ type: [\'pr-fix-observation\'] }` -- now '
      + '`{ type: [\'observation\'] }` followed by an in-memory filter '
      + 'on `metadata.kind`.\n\n'
      + '**Why this is the most important fix:** PR1 (the agent-loop '
      + 'substrate) set the precedent that `AgentSessionMeta` and '
      + '`AgentTurnMeta` are framework primitives in '
      + '`src/substrate/types.ts` -- because the agent-loop substrate '
      + 'IS a substrate. PrFixObservationMeta and the '
      + '`\'pr-fix-observation\'` literal were actor-specific shapes '
      + 'that did NOT belong there. The sibling pr-landing actor '
      + 'never lifted its analogous shape into substrate; it used '
      + 'the generic `observation` atom with a discriminator. PR-fix '
      + 'now matches that bar exactly.\n\n'
      + '**Why this matters at scale:** every actor that thinks "I '
      + 'need an atom type" would otherwise land its own union '
      + 'member, and `AtomType` would drift from a stable framework '
      + 'primitive to an actor catalog. The discipline directive '
      + '`framework code under src/ must stay mechanism-focused and '
      + 'pluggable. Role names, specific org shapes, vendor-specific '
      + 'logic, and instance configuration belong in canon, skills, '
      + 'or examples, never in src/` is exactly the canon atom that '
      + 'made this revert non-negotiable.\n\n'
      + '**External behavior unchanged:** consumers that need to '
      + 'find pr-fix observations now query `type: [\'observation\']` '
      + 'and filter on `metadata.kind === \'pr-fix-observation\'`. '
      + 'The shape of every per-atom record is the same; only the '
      + 'discriminator location moves from `type` to `metadata.kind`. '
      + 'The actor\'s in-memory return shape (`PrFixObservation`) is '
      + 'unchanged.',
  },
  // ---- Finding 9 -------------------------------------------------------
  {
    id: 'PRRT_kwDOSGhm9859mZ00',
    label: 'F9 (Minor) git-worktree-provider.test.ts:195 -- rm cleanup outside try/finally',
    body:
      'Fixed in 919888c.\n\n'
      + '**What changed:** wrapped the entire test body (mkdtemp -> '
      + 'execa setup -> provider.acquire assertion) in '
      + '`try { ... } finally { await rm(dir, {recursive:true, '
      + 'force:true}); }`. Mirrors the sibling test at L170-173 of '
      + 'the same file.\n\n'
      + '**Why:** if the `expect(...).rejects.toThrow(...)` assertion '
      + 'fails (or any of the `execa` setup steps throws), control '
      + 'never reaches the bottom-of-function `await rm(dir, ...)` and '
      + 'the bootstrap repo lingers in `os.tmpdir()` indefinitely. '
      + 'Test failures should not leak temp dirs; the repo\'s '
      + '`afterEach` only cleans the suite-level `repoDir`, not the '
      + 'per-test bootstrap repos created inside individual tests.\n\n'
      + '**Edge case:** moved the `git init / config / write / add / '
      + 'commit` setup INTO the try block too, not just the assertion. '
      + 'Otherwise a flaky `git init` would still leak the empty '
      + '`mkdtemp` dir before the try ever opens. The full critical '
      + 'section is now atomic w.r.t. cleanup.',
  },
  // ---- Finding 10 ------------------------------------------------------
  {
    id: 'PRRT_kwDOSGhm9859mZ02',
    label: 'F10 (Minor) atom-types.test.ts:75 -- vendor language in PrFixObservationMeta JSDoc',
    body:
      'Fixed in cdf1b33 (rolled into the substrate revert commit).\n\n'
      + '**What changed:** the JSDoc reference to "GitHub PR snapshot" '
      + 'is gone. The interface now lives in '
      + '`src/runtime/actors/pr-fix/types.ts` (per Finding 8) and the '
      + 'rewritten JSDoc reads "carries the PR snapshot the actor '
      + 'classified on" -- mechanism-neutral, no vendor attribution.\n\n'
      + '**Why this finding folded into F8:** F8 already required '
      + 'moving the interface; while moving it I rewrote the JSDoc to '
      + 'mechanism-neutral form in the same edit. Keeping them in one '
      + 'commit kept the substrate revert reviewable as a single '
      + 'atomic change.\n\n'
      + '**Field set kept as-is:** `pr_owner`, `pr_repo`, `pr_number`, '
      + '`merge_state_status`, `cr_review_states` are GitHub-shaped '
      + 'literally, but they live in the actor module now (not in '
      + 'src/substrate), where vendor-shaped fields are allowed. If '
      + 'multi-forge support becomes a priority, the right fix is '
      + 'either to generalize the field names (`pr_id`, '
      + '`review_states`) with a `forge` discriminator, or to push '
      + 'forge-specific fields into the existing `extra` open '
      + 'extension slot. Per CR\'s own note this is "optional '
      + 'refactoring, not a current blocker"; tracking via the '
      + 'follow-up backlog.',
  },
  // ---- Finding 11 ------------------------------------------------------
  {
    id: 'PRRT_kwDOSGhm9859mZ04',
    label: 'F11 (Critical) tsconfig.examples.json:13 -- TS6310 composite + --noEmit',
    body:
      'Fixed in bd8e7ed using your option 1 (separate non-composite '
      + 'typecheck config).\n\n'
      + '**What changed:**\n'
      + '1. New `tsconfig.typecheck.json` extending the root config '
      + 'but disabling composite + incremental:\n'
      + '```json\n'
      + '{\n'
      + '  "extends": "./tsconfig.json",\n'
      + '  "compilerOptions": {\n'
      + '    "noEmit": true,\n'
      + '    "composite": false,\n'
      + '    "incremental": false,\n'
      + '    "rootDir": "."\n'
      + '  },\n'
      + '  "include": ["src/**/*", "examples/**/*"],\n'
      + '  "exclude": ["node_modules", "dist", "test"]\n'
      + '}\n'
      + '```\n'
      + '2. package.json `typecheck` reverted to '
      + '`tsc --noEmit -p tsconfig.typecheck.json`.\n'
      + '3. `build`, `build:src`, `build:examples` still use `tsc -b`. '
      + 'The emit path remains correct on the build side; the '
      + 'typecheck path is now decoupled from the composite project '
      + 'graph.\n\n'
      + '**Why option 1 over option 2 (`emitDeclarationOnly: true`):** '
      + 'as you noted, emitDeclarationOnly is not recommended for '
      + 'composite projects in active development -- it locks the '
      + 'build path into a less-flexible mode for the sake of a '
      + 'typecheck convenience. Splitting typecheck and build into '
      + 'two configs is the cleaner separation: typecheck and build '
      + 'are different phases with different constraints, and each '
      + 'config now expresses its phase\'s requirements directly.\n\n'
      + '**One subtlety I had to handle:** the inherited '
      + 'compilerOptions from the root tsconfig include '
      + '`rootDir: ./src`, which causes TS6059 against `examples/**/*` '
      + '("not under rootDir"). Added `rootDir: "."` to the typecheck '
      + 'config to broaden the root for the typecheck phase only; the '
      + 'build configs keep their narrower roots so emit layout is '
      + 'unaffected.\n\n'
      + '**Edge case:** the prior interim fix at c9e575f (which just '
      + 'dropped --noEmit from the typecheck script) still worked '
      + 'mechanically but conflated typecheck and build; CR\'s '
      + 'cleaner separation is now in place. The interim commit '
      + 'remains in history for the audit trail.',
  },
];

// Routes every gh call through `scripts/gh-as.mjs lag-ceo` so writes
// attribute to the lag-ceo bot identity (not the operator). Mirrors the
// canon `feedback_never_github_actions_as_operator` discipline. The
// gh-as wrapper mints a fresh installation token for the child process
// only; we never inherit GH_TOKEN from the operator's shell.
//
// gh-as.mjs uses `stdio: 'inherit'` for the child gh process; with our
// `stdio: ['pipe','pipe','pipe']` here, execSync pipes the body into
// Node's stdin, gh-as inherits that fd to gh, gh's stdout (the JSON
// response) comes back on our captured stdout, and the `[gh-as]`
// audit-log line goes to stderr (not captured here).
function ghApi(query, variables = {}) {
  const body = JSON.stringify({ query, variables });
  try {
    const out = execSync('node scripts/gh-as.mjs lag-ceo api graphql --input -', {
      input: body,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(out.toString());
  } catch (err) {
    const stderr = err.stderr?.toString() ?? '';
    const stdout = err.stdout?.toString() ?? '';
    throw new Error(`gh-as graphql failed: ${stderr || stdout || err.message}`);
  }
}

let replied = 0;
let resolved = 0;
let failures = 0;

for (const t of threads) {
  console.log(`\n== ${t.label} ==`);

  const reply = ghApi(
    `mutation($threadId: ID!, $body: String!) {
       addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
         comment { id url }
       }
     }`,
    { threadId: t.id, body: t.body },
  );
  if (reply.errors) {
    console.error('reply errors:', JSON.stringify(reply.errors));
    failures += 1;
    continue;
  }
  console.log('replied:', reply.data.addPullRequestReviewThreadReply.comment.url);
  replied += 1;

  const res = ghApi(
    `mutation($threadId: ID!) {
       resolveReviewThread(input: { threadId: $threadId }) {
         thread { isResolved }
       }
     }`,
    { threadId: t.id },
  );
  if (res.errors) {
    console.error('resolve errors:', JSON.stringify(res.errors));
    failures += 1;
    continue;
  }
  console.log('resolved:', res.data.resolveReviewThread.thread.isResolved);
  resolved += 1;
}

console.log(`\n== summary ==\nreplied: ${replied}/${threads.length}\nresolved: ${resolved}/${threads.length}\nfailures: ${failures}`);
process.exit(failures > 0 ? 1 : 0);
