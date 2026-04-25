# Real ClaudeCodeAgentLoopAdapter Design (PR3 of agentic-actor-loop)

**Author:** lag-ceo
**Date:** 2026-04-25
**Status:** Proposed
**Tracks:** Section 8.3 / Section 9 follow-up to `docs/superpowers/specs/2026-04-25-agentic-actor-loop-design.md`.
**Replaces (on land):** the substrate-validation skeleton at `examples/agent-loops/claude-code/loop.ts` shipped via PR #166.
**Consumed by:** `AgenticCodeAuthorExecutor` shipped via PR #167.

---

## 1. Goal

Ship a production `AgentLoopAdapter` that spawns the Claude Code CLI in agentic-headless mode, captures every assistant turn + tool-call as `agent-turn` atoms, and returns commit/branch artifacts to `AgenticCodeAuthorExecutor`. After this lands, the agentic-actor-loop substrate runs an actual LLM in an isolated workspace end-to-end; today the path is plumbing-only.

Non-goals:
- `strict` replay tier (canon snapshot pinning)  --  deferred follow-up.
- `AgentSessionMeta.confidence` field  --  substrate does not model it yet.
- Other-actor migrations (planning / auditor / pr-landing)  --  each has its own follow-up plan.
- API-key-based SDK invocation  --  the project standardised on Claude Code CLI OAuth (no API key required); this PR follows that.

---

## 2. Architecture

```
AgenticCodeAuthorExecutor
  └─ ClaudeCodeAgentLoopAdapter.run({task, workspace, budget, redactor, blobStore, ...})
       ├─ execa('claude', args, {cwd: workspace.path, signal: combined})
       │    args = ['-p', '<prompt>',
       │            '--output-format', 'stream-json',
       │            '--verbose',                // REQUIRED for stream-json to emit per-turn lines
       │            '--max-budget-usd', '<budget.max_usd>',
       │            '--disallowedTools', '<toolPolicy.disallowedTools joined by space>',
       │            '--disable-slash-commands',
       │            '--mcp-config', '{"mcpServers":{}}']
       ├─ readline stdout: parse one JSON message per line (NDJSON)
       │    ├─ on system event           -> open turn N: write placeholder agent-turn atom
       │    │                              (preserves substrate "atom-before-LLM-call" contract)
       │    ├─ on assistant.text         -> redact text; update turn N atom with llm_output
       │    ├─ on assistant.tool_use     -> append to turn N tool_calls (outcome 'success'
       │    │                              optimistic; corrected on tool_result)
       │    ├─ on user.tool_result       -> match by tool_use_id; set outcome (see 4.x);
       │    │                              attach redacted result
       │    └─ on result envelope        -> capture cost_usd, usage; update session atom
       ├─ adapter-side guards:
       │    ├─ wall_clock_ms timer       -> SIGTERM (then SIGKILL after 5s)
       │    ├─ assistant turn counter    -> kill at max_turns
       │    └─ AbortSignal                -> SIGTERM
       └─ post-CLI artifact capture (uses workspace.baseRef from substrate Workspace shape):
            ├─ git rev-parse HEAD
            ├─ git branch --show-current
            └─ git diff --name-only <workspace.baseRef>..HEAD
```

The working directory is set via execa's `cwd:` option, NOT a CLI flag (the Claude CLI does not recognize `--cwd`; the project's existing CLI integrations all set it through execa). Pairing `--output-format stream-json` with `--verbose` is mandatory: without `--verbose` the CLI does not emit per-turn NDJSON lines (validated against `src/daemon/cli-renderer/claude-streaming.ts:120-135`, the canonical reference for stream-json invocation).

**One CLI invocation per `run()` call.** Claude Code's `claude -p` already iterates internally: the agent reasons, calls tools, gets results, reasons again, until a stop condition (success, tool budget, model budget). The adapter does NOT loop. Adapter responsibility is plumbing: spawn, stream-parse, atom-write, artifact-capture, signal-forward.

**Why subprocess + stream-json, not the SDK:** The codebase already authenticates against Claude via the operator's existing Claude Code OAuth install (`src/adapters/claude-cli/llm.ts`, `src/integrations/agent-sdk/cli-client.ts`). Switching to the Anthropic SDK would require `ANTHROPIC_API_KEY` and bifurcate the auth path. Stream-json mode is the documented format for per-turn message capture.

---

## 3. Components

Single file: `examples/agent-loops/claude-code/loop.ts` (replaces the skeleton). The skeleton class `ClaudeCodeAgentLoopSkeleton` is removed entirely; tests already use ad-hoc stubs (`test/e2e/agentic-actor-loop-chain.test.ts`'s `stubAdapter`) so no test surface depends on the skeleton.

### 3.1 `ClaudeCodeAgentLoopAdapter` (the class)

```ts
export interface ClaudeCodeAgentLoopOptions {
  readonly claudePath?: string;            // default: 'claude' on PATH
  readonly extraArgs?: ReadonlyArray<string>;
  readonly verbose?: boolean;
  readonly execImpl?: typeof execa;        // injectable for tests
  readonly killGracePeriodMs?: number;     // default 5000 (SIGTERM → SIGKILL)
}

export class ClaudeCodeAgentLoopAdapter implements AgentLoopAdapter {
  readonly capabilities: AdapterCapabilities = {
    tracks_cost: true,
    supports_signal: true,
    classify_failure: classifyClaudeCliFailure,
  };
  constructor(opts?: ClaudeCodeAgentLoopOptions);
  async run(input: AgentLoopInput): Promise<AgentLoopResult>;
}
```

### 3.2 `StreamJsonParser` (pure, unit-testable)

Reads NDJSON from a stdout stream into typed events:
- `SessionStart` (from CLI's `system` message)
- `AssistantText` (from `assistant.content[].type === 'text'`)
- `AssistantToolUse` (from `assistant.content[].type === 'tool_use'`)
- `ToolResult` (from `user.content[].type === 'tool_result'`)
- `ResultEnvelope` (final summary with cost + usage)
- `ParseError` (malformed line  --  surfaces with offending line preview, does NOT halt the loop; the substrate spec wants the adapter to keep going through partial corruption)

### 3.3 `buildPromptText(task: AgentTask): string` (pure)

Assembles the user prompt:
1. `task.questionPrompt` (the operator's literal request).
2. If `task.fileContents` is non-empty: a fenced `<file_contents path="...">...</file_contents>` block per entry. Mirrors the diff-based path's pattern of injecting context.
3. If `task.successCriteria`: a `<success_criteria>...</success_criteria>` block.
4. If `task.targetPaths`: a `<target_paths>foo.ts, bar.ts</target_paths>` advisory block.

### 3.4 `captureArtifacts(workspace, execImpl)` (pure-ish, runs git)

Reads `workspace.baseRef` from the substrate `Workspace` shape (`src/substrate/workspace-provider.ts`) -- the WorkspaceProvider already records the base ref it created the worktree from. Runs three git commands inside `workspace.path`:
- `git rev-parse HEAD` -> `currentSha`
- `git rev-parse <workspace.baseRef>` -> `baseSha`
- If `currentSha === baseSha`: returns `undefined` (no commit was made; executor maps to `agentic/no-artifacts`).
- Otherwise: `git branch --show-current` -> `branchName`; `git diff --name-only <workspace.baseRef>..HEAD` -> `touchedPaths`.

Returns `{commitSha, branchName, touchedPaths}` or `undefined`.

### 3.5 `classifyClaudeCliFailure(err, exitCode, stderr)` (adapter-specific classifier)

Beats `defaultClassifyFailure` by inspecting CLI-specific stderr shapes. Match precedence is top-down: the FIRST matching row wins, so a 401 page that also mentions "rate limit" is classified as `catastrophic` (auth) rather than `transient` (rate). Cases:

| # | Signal | Mapping |
|---|---|---|
| 1 | `AbortError` / SIGTERM forwarded from `AbortSignal` | `catastrophic` |
| 2 | `ENOENT` / `claude: command not found` (CLI not installed) | `catastrophic` |
| 3 | stderr matches `/auth\|401\|403/i` | `catastrophic` |
| 4 | stderr matches `/budget/i` AND non-zero exit | (returned at adapter level as `kind: 'budget-exhausted'`, not as `kind: 'error'`) |
| 5 | stderr matches `/rate limit\|429/i` | `transient` |
| 6 | Any other non-zero exit | `structural` |

Falls back to `defaultClassifyFailure` for non-CLI errors (e.g. internal adapter exceptions raised before the subprocess started).

### 3.6 `spawnClaudeCli({...})` (execa wrapper, injectable)

Constructs argv (mirrors `src/daemon/cli-renderer/claude-streaming.ts:120-135`):
```
['-p', '<prompt>',
 '--output-format', 'stream-json',
 '--verbose',                        // REQUIRED for stream-json to emit per-turn lines
 '--disable-slash-commands',
 '--mcp-config', '{"mcpServers":{}}',
 ...(toolPolicy.disallowedTools.length
    ? ['--disallowedTools', toolPolicy.disallowedTools.join(' ')]
    : []),
 ...(budget.max_usd !== undefined
    ? ['--max-budget-usd', String(budget.max_usd)]
    : []),
 ...(opts.extraArgs ?? [])]
```

The binary is `opts.claudePath ?? 'claude'`. Execa options:
- `cwd: workspace.path` (working directory; NOT a CLI flag, the CLI does not recognize `--cwd`)
- `env: process.env`
- `stripFinalNewline: false`
- `signal`: an `AbortSignal` derived from `input.signal` AND the adapter-side wall-clock timer (whichever fires first)
- `stdout` is consumed as a stream (NDJSON parser); the adapter does NOT use execa's text-buffering mode

---

## 4. Data flow per turn

The atom shape MUST match the substrate `AgentTurnMeta` contract (`src/substrate/types.ts:570-597`). Specifically:

```ts
{
  session_atom_id: AtomId,
  turn_index: number,
  llm_input:  { inline: string } | { ref: BlobRef },
  llm_output: { inline: string } | { ref: BlobRef },
  tool_calls: ReadonlyArray<{
    tool: string,
    args:   { inline: string } | { ref: BlobRef },
    result: { inline: string } | { ref: BlobRef },
    latency_ms: number,
    outcome: 'success' | 'tool-error' | 'policy-refused',
  }>,
  latency_ms: number,
  failure?: FailureRecord,
  extra?: Readonly<Record<string, unknown>>,
}
```

The substrate vocabulary uses `tool` (not `tool_name`), `args` (not `args_redacted`), `result` (not `result_redacted`), and the discriminated union `{inline} | {ref}` for both args and result. The CLI-side `tool_use_id` (used by the adapter to correlate tool_use with tool_result on the stream) is NOT a substrate field; the adapter keeps it in an in-memory correlation map and discards it after the corresponding `tool_result` lands. There is no `'pending'` outcome in the substrate; see §4.1 for how the adapter handles in-flight tool calls before a result arrives.

### 4.0 Substrate-contract discipline: write-atom-before-LLM-call via placeholder

The substrate (`src/substrate/agent-loop.ts:46-47`) MANDATES: "Write an `agent-turn` atom for each LLM call BEFORE issuing the call (so the audit trail captures even mid-turn crashes)." This is a non-negotiable invariant; bypassing it would lose audit trail on subprocess crashes.

The adapter satisfies this by writing a **placeholder** turn atom on the boundary that signals an LLM call is about to start, then `update()`ing it as content streams in:

| Stream-json signal | Adapter atom action |
|---|---|
| `system` event (CLI emits it once at session start, with model + session_id) | Open turn 0 (placeholder): write `agent-turn` atom with `{turn_index: 0, llm_input: {inline: <buildPromptText output>}, llm_output: {inline: ''}, tool_calls: []}`. This captures the prompt the CLI received BEFORE the LLM produces output. |
| `user` event with `tool_result` blocks (CLI feeds tool results back to the LLM, which triggers the next LLM call) | Open turn N+1 (placeholder): write `agent-turn` atom with `{turn_index: N+1, llm_input: {inline: '<tool-results-summary>'}, llm_output: {inline: ''}, tool_calls: []}`. Mid-turn crash here would leave a complete audit trail through turn N + a placeholder for the in-flight turn N+1. |
| `assistant` event (text content; the LLM's response landed) | `host.atoms.update()` the current turn atom: redact text via `input.redactor`, set `llm_output` to `{inline: redacted}` or `{ref: BlobRef}` when over `blobThreshold`. |
| `assistant` event (tool_use block; LLM is calling a tool) | `host.atoms.update()` the current turn: append a `tool_calls` entry with `{tool: tool_use.name, args: redacted, result: {inline: ''}, latency_ms: 0, outcome: 'success'}` AND record the `tool_use_id` in an in-memory map so the corresponding `tool_result` can attach later. The optimistic `'success'` is updated to `'tool-error'` or `'policy-refused'` when the result lands. |
| `user` event with `tool_result` block (CLI is feeding a tool result back to the LLM) | `host.atoms.update()` the matching turn: set the `tool_calls[].result` to `{inline: redacted}` or `{ref}`; set `outcome` per §4.2; update `tool_calls[].latency_ms` to elapsed-ms since the tool_use record. THEN open the next placeholder turn (above row). |
| `result` envelope (final, contains `cost_usd`, `usage`, `is_error`) | Update the SESSION atom: `terminal_state` per `is_error` + adapter's classification, `budget_consumed.usd = cost_usd`, `budget_consumed.turns = <count of opened turns>`, `budget_consumed.wall_clock_ms = <Date.now() - startedAt>`, `completed_at = <now>`. |

The **stream-json envelope's cost field is `cost_usd`, not `total_cost_usd`** (validated against `src/daemon/cli-renderer/claude-stream-parser.ts:159`). The JSON-format envelope (used by the existing single-shot `ClaudeCliLLM`) reports `total_cost_usd`; the streaming envelope renames it. The adapter reads `cost_usd` and maps it onto `AgentSessionMeta.budget_consumed.usd`.

**Turn-index source.** `turn_index` is the adapter's local counter (0, 1, 2, ...), not derived from any CLI session-state field. It increments on each placeholder open. Decoupling this from CLI internals means a future CLI behavior change cannot silently desync the substrate's turn ordering.

### 4.1 Turn-write atomicity guarantee

After the placeholder pattern above, every LLM call has a turn atom in the store BEFORE the call's output lands. Subprocess crash mid-turn -> the audit trail shows turn 0..N completed and turn N+1 as a placeholder with empty `llm_output`. Replay tooling can recognize the empty-output shape as "interrupted in-flight" and surface that to the operator. The strict substrate contract is satisfied; no operator-approval-for-deviation is required.

### 4.2 Distinguishing `tool-error` from `policy-refused`

Both surfaces look like `{is_error: true}` in stream-json's `tool_result`. The substrate distinguishes them: `'policy-refused'` means the tool was blocked by `toolPolicy.disallowedTools`; `'tool-error'` means the tool ran but returned an error.

The CLI emits a recognizable refusal message when `--disallowedTools` blocks a call: the `tool_result.content` text starts with the literal phrase "Permission denied" or "tool not allowed" (per CLI behavior; the adapter recognizes via case-insensitive substring match on the literal phrases). When that match holds AND `is_error: true`, the adapter sets `outcome: 'policy-refused'`. Otherwise `is_error: true` -> `'tool-error'`. `is_error: false` -> `'success'`.

If the CLI changes its refusal-message wording, the adapter falls back to `'tool-error'` for any unrecognized error string. This is a graceful degradation: the CR-substrate spec's only hard requirement is "tool denials surface as a refusal the agent can reason about" (which the CLI already does inside its own loop); the adapter's substrate-side classification of `policy-refused` vs `tool-error` is best-effort observability, not a security boundary.

### 4.3 Blob threshold routing

`input.blobThreshold` (already clamped via `clampBlobThreshold`) is the inline-vs-blob cutoff in bytes for any UTF-8-encoded payload (turn output, tool args, tool result). Each redacted payload over threshold goes through `blobStore.put()`; the atom carries the resulting `BlobRef` instead of inline content (`{ref: BlobRef}` form of the discriminated union).

### 4.4 Replay tier semantics

`input.replayTier` is captured on the session atom's `replay_tier`. The adapter implements:
- `best-effort`: same as content-addressed today; no canon snapshot.
- `content-addressed` (default): every payload over threshold lives in blobStore, addressable by `BlobRef`.
- `strict`: same as content-addressed for now; canon-snapshot pinning is deferred.

Future-strict will compute a canon-snapshot hash at session start and pin it via `canon_snapshot_blob_ref`. Out of scope for this PR.

---

## 5. Capabilities

```ts
{
  tracks_cost: true,                   // stream-json `result` envelope emits `cost_usd`
  supports_signal: true,               // we forward SIGTERM (then SIGKILL after killGracePeriodMs)
  classify_failure: classifyClaudeCliFailure,
}
```

---

## 6. Error handling

| Condition | `kind` | `failure` |
|---|---|---|
| Subprocess exits 0, valid `result` envelope | `'completed'` | undefined |
| Subprocess exits 0, no commit detected | `'completed'` (artifacts undefined → executor maps to `agentic/no-artifacts`) | undefined |
| Wall-clock timer fires | `'aborted'` | `{kind: 'catastrophic', reason: 'wall-clock budget exhausted'}` |
| Turn counter > `max_turns` | `'budget-exhausted'` | `{kind: 'structural', reason: 'turn budget hit', stage: 'max-turns-cap'}` |
| `AbortSignal.aborted === true` | `'aborted'` | `{kind: 'catastrophic', reason: 'caller cancelled'}` |
| stderr matches `/rate limit|429/i`, non-zero exit | `'error'` | `{kind: 'transient', reason: stderr.slice(0, 1000)}` |
| stderr matches `/budget/i`, non-zero exit | `'budget-exhausted'` | `{kind: 'structural', reason: 'CLI reported budget'}` |
| stderr matches `/auth|401|403/i`, non-zero exit | `'error'` | `{kind: 'catastrophic', reason: stderr.slice(0, 1000)}` |
| stderr matches `/ENOENT|command not found/i` | `'error'` | `{kind: 'catastrophic', reason: 'claude binary not found'}` |
| Other non-zero exit | `'error'` | `{kind: 'structural', reason: stderr.slice(0, 1000)}` |
| Unparseable stream-json line | logged + skipped (does NOT abort the loop) | n/a |

---

## 7. Security + correctness

### 7.1 Threat model

- **Subprocess inherits workspace creds.** `git-as` / `gh-as` look in `<workspace>/.lag/apps/`. The `WorkspaceProvider` is responsible for provisioning creds with minimum scope; the adapter does not touch creds itself.
- **Tool policy is plumbing.** The substrate's `toolPolicy.disallowedTools` is forwarded to the CLI via `--disallowedTools`. The CLI does the actual blocking; tool denials surface as `tool_use_result` with `is_error: true` in the stream and become `tool_calls[].outcome: 'policy-refused'` in the atom (via the adapter's classifier).
- **Redaction is mandatory at write time.** Every payload (turn output, tool args, tool result) goes through `input.redactor.redact()` BEFORE atom write or BlobStore put. A redactor crash is a substrate violation: rethrow as `kind: 'error'` with `failure: catastrophic`. Never write unredacted content.
- **Commit SHA is unverified.** The executor (PR2) already documents that the adapter-supplied `commitSha` is unverified by the executor; that downstream check is its responsibility, not the adapter's.
- **Stream-JSON parser is defensive.** Malformed lines are logged + skipped, never thrown. The CLI may emit non-JSON output during initialization (warnings, stderr-redirected messages); the parser tolerates it.
- **No prompt-injection countermeasures.** A malicious `task.questionPrompt` could attempt to instruct the agent to exfil. Substrate-level threat: not the adapter's job. The redactor catches secret-shaped exfil at write time; the workspace boundary catches FS exfil (the adapter sets `cwd: workspace.path` on the subprocess so the CLI's relative path operations resolve inside the worktree; absolute paths supplied by the agent are still reachable but the existing diff-based-executor `readTargetContents` boundary check applies downstream); tool-policy catches tool exfil. Defense is layered.
- **Argv injection.** All argv values are passed via execa as separate array elements, never shell-interpolated. Tool names and `disallowedTools` are joined with `' '` (the CLI's documented separator) but never shell-escaped because execa doesn't run a shell.

### 7.2 Pre-push checklist parity

Per `feedback_pre_push_grep_checklist`: the implementer runs `grep -rP $'\u2014' src/ test/ docs/ examples/ README.md` + private-term + design-link checks before every push.

### 7.3 Per-task security walkthrough

Per `feedback_security_correctness_at_write_time`: every plan task carries a "Security + correctness considerations" subsection that the implementer subagent walks through BEFORE writing code, not after CR flags it.

---

## 8. Testing

### 8.1 Unit tests (`test/examples/claude-code-agent-loop.test.ts`)

- `StreamJsonParser` round-trips synthetic NDJSON: system + assistant-text + assistant-tool_use + user-tool_result + result envelope. Asserts event ordering + payload shapes.
- `StreamJsonParser` tolerates malformed lines: feed `{"valid": 1}\nGARBAGE\n{"valid": 2}\n`; assert two events emitted, parse-error logged once.
- `buildPromptText` produces expected format for: prompt-only, prompt+files, prompt+files+criteria+target-paths.
- `captureArtifacts` returns `{commitSha, branchName, touchedPaths}` after a real `git init` / `commit` cycle in a tmp dir; returns `undefined` when `HEAD === baseRef`.
- `classifyClaudeCliFailure` covers the table cells in §6.

### 8.2 Adapter-with-stub tests (`test/examples/claude-code-agent-loop-adapter.test.ts`)

Use `execImpl` stub to feed canned NDJSON. Assert:
- `agent-session` atom written on entry; `terminal_state` updated on exit.
- One `agent-turn` atom per assistant text event.
- `tool_calls` populated correctly across tool_use → tool_result pairs.
- Large payloads (over `blobThreshold`) routed through `blobStore.put()`.
- Budget cap (`max_turns`) terminates the run with `kind: 'budget-exhausted'`.
- `AbortSignal` causes `kind: 'aborted'` with `failure: catastrophic`.
- All payloads went through `redactor.redact()` (assert by counting redactor calls).

### 8.3 Real-process integration test (opt-in)

Behind `process.env.CLAUDE_CODE_INTEGRATION_TEST` (skipped by default), runs `claude -p "echo hello"` actually; asserts the stream-json parser round-trips real output without surprises. Operator opts in locally; CI does not run this (no Claude OAuth in CI).

### 8.4 End-to-end on `MemoryHost`

Extend `test/e2e/agentic-actor-loop-chain.test.ts` with one test that uses the real adapter (with `execImpl` stub) instead of the inline `stubAdapter()`. Validates the full chain: plan -> AgenticCodeAuthorExecutor -> real adapter (stubbed CLI) -> atoms in MemoryHost -> session-tree projection -> dispatched PR result. The test asserts that emitted `agent-turn` atoms match the canonical `AgentTurnMeta` shape exactly (`tool` not `tool_name`, `args` / `result` as `{inline} | {ref}`, `outcome` in `'success' | 'tool-error' | 'policy-refused'`) so a future refactor cannot silently drift back to a non-canonical shape.

---

## 9. Phasing

Single PR. The work decomposes into ~10 plan tasks (parser, prompt builder, classifier, artifact capture, spawn wrapper, adapter shell, blob threshold integration, budget guards, signal handling, end-to-end test) but they're cohesive enough to land together. The skeleton removal is part of the same PR.

---

## 10. Provenance

**Canon directives this design respects:**
- `dev-substrate-not-prescription`: the adapter lives in `examples/`; framework code in `src/` stays mechanism-only.
- `simple-surface-deep-architecture`: the adapter is one file; the substrate's pluggability is unchanged.
- `dev-flag-structural-concerns-proactively`: §4.0 documents how the placeholder-then-enrich pattern satisfies the strict "write atom before LLM call" contract under stream-json's event ordering, and explicitly traces each LLM-call boundary signal.
- `inv-provenance-every-write`: every atom carries `derived_from` linking session -> turn -> atoms.
- `inv-governance-before-autonomy`: budget caps + signal forwarding + tool-policy plumbing all enforce caller-controlled bounds.
- `dev-extreme-rigor-and-research`: this design covers 6 stream-json event types, 9 failure-mapping rows, and 4 test categories.
- `dev-no-hacks-without-approval`: the placeholder pattern in §4.0 satisfies the strict substrate contract directly; no operator-approved deviation is required.
- `dev-forward-thinking-no-regrets`: strict replay tier is reserved (computed-at-session-start hash) without breaking content-addressed today.

**Atoms / memory / prior PRs:**
- PRs #166 (substrate foundations) + #167 (AgenticCodeAuthorExecutor) shipped the seam this adapter consumes.
- `project_pr2_agentic_code_author_executor_landed.md`  --  out-of-scope list explicitly named "real Claude Code CLI subprocess integration" as the next thing.
- `feedback_security_correctness_at_write_time.md`  --  every plan task gets a security walkthrough up front.
- `feedback_cr_recurring_pattern_presubmit_checklist.md`  --  pre-push grep + JSDoc parity checks before every push.

**Existing CLI integrations this builds on (NOT replaces):**
- `src/adapters/claude-cli/llm.ts`  --  single-shot judge surface; STAYS for drafter / planner.
- `src/integrations/agent-sdk/cli-client.ts`  --  single-shot deliberation client; STAYS for virtual-org bootstrap.
- This PR adds a third CLI integration purpose-built for streaming agentic mode. The three coexist; each has a distinct invocation pattern (json envelope vs json envelope vs stream-json).

---

## 11. What breaks if we revisit

- **Stream-json schema change in the CLI** would require parser updates. Risk: low; the format is documented and stable.
- **CLI removes `--max-budget-usd` or renames `--disallowedTools`** would break the budget / tool-policy plumbing. The adapter-side guards still terminate the run; the loss is the CLI-side enforcement of those caps. Acceptable degradation.
- **CLI adds `--max-turns`** would let us simplify (drop adapter-side turn counting). Strictly an improvement.
- **A future strict-replay-tier implementation** would add canon-snapshot hashing at session start. Additive; non-breaking.
