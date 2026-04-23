/**
 * Virtual-org bootstrap library.
 *
 * Reusable building blocks for the boot script and the e2e test:
 *   - `loadSeedPrincipals`: walk the principals/ dir and return the
 *     parsed Principal records plus their (JSON-only) `model` field.
 *   - `createDeliberationSink`: build a sink that translates each
 *     DeliberationEvent emitted by the coordinator into a proper core
 *     Atom and calls `atomStore.put(atom)`. This is the join point
 *     between the pattern layer (Question/Position/Counter/Decision/
 *     Escalation) and the substrate (atoms with full provenance).
 *   - `createReasoningSink`: parallel sink for the agent-process
 *     thinking stream; each thinking block becomes an observation
 *     atom derived from the parent question.
 *   - `runDeliberation`: compose everything above + the Anthropic
 *     client + kill-switch into a single call the boot script and
 *     the e2e test both use.
 *
 * The helper deliberately stays free of CLI-specific logic (stdin,
 * argv, env-based secret lookup) so both the operator-facing
 * `boot.mjs` entry point and the mocked vitest e2e exercise the
 * same code path. Tests using this module inject a mocked Anthropic
 * client via `anthropic`; production passes `new Anthropic()`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AtomStore, Host, PrincipalStore } from '../../substrate/interface.js';
import type {
  Atom,
  AtomId,
  Principal,
  PrincipalId,
} from '../../substrate/types.js';
import type {
  Counter,
  Decision,
  Escalation,
  Position,
  Question,
} from '../../substrate/deliberation/patterns.js';
import { renderForPrincipal } from '../../substrate/canon-md/index.js';

import {
  createCliClient,
  deliberate,
  executeDecision,
  startAgent,
  type AgentHandle,
  type CanonRendererForPrincipal,
  type CodeAuthorFn,
  type CreateCliClientOptions,
  type DeliberationEvent,
  type DeliberationSink,
  type ExecuteDecisionResult,
  type ExecutionFailedAtom,
  type MessagesClient,
  type PrOpenedAtom,
  type ReasoningEvent,
  type ReasoningSink,
} from '../../integrations/agent-sdk/index.js';

// ---------------------------------------------------------------------------
// Seed principal loader
// ---------------------------------------------------------------------------

/**
 * Parsed seed principal: the core Principal shape plus a sidecar
 * `model` string used by agent-process to pick the Anthropic model.
 * `model` is not part of the core Principal interface because the
 * substrate stays vendor-neutral; it lives here so the bootstrap
 * example stays self-contained.
 */
export interface SeedPrincipal {
  readonly principal: Principal;
  readonly model: string;
}

export interface LoadSeedPrincipalsOptions {
  readonly dir: string;
}

export function loadSeedPrincipals(
  opts: LoadSeedPrincipalsOptions,
): ReadonlyArray<SeedPrincipal> {
  const seeds = readdirSync(opts.dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const raw = readFileSync(join(opts.dir, f), 'utf8');
      const parsed = JSON.parse(raw) as Principal & { model?: string };
      const model = typeof parsed.model === 'string' && parsed.model.length > 0
        ? parsed.model
        : 'claude-opus-4-7';
      const { model: _m, ...principal } = parsed as Principal & { model?: string };
      return { principal: principal as Principal, model };
    });
  return seeds;
}

export function defaultPrincipalsDir(): string {
  return fileURLToPath(new URL('./principals/', import.meta.url));
}

// ---------------------------------------------------------------------------
// Canon fixture loader
// ---------------------------------------------------------------------------

/**
 * Load the committed canon fixtures under `./canon/` and return them
 * as core Atom records. The boot script and the e2e test both seed
 * these into the AtomStore before the deliberation starts so the
 * policy-by-id references (e.g. pol-two-principal-approve-for-l3-
 * merges) resolve.
 */
export function loadCanonFixtures(
  dir: string = defaultCanonDir(),
): ReadonlyArray<Atom> {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Atom);
}

export function defaultCanonDir(): string {
  return fileURLToPath(new URL('./canon/', import.meta.url));
}

// ---------------------------------------------------------------------------
// Deliberation sink: patterns -> atoms
// ---------------------------------------------------------------------------

/**
 * Build a DeliberationSink that converts each coordinator-emitted
 * event into a core Atom and writes it to the AtomStore. Question
 * atoms use type='question', Position/Counter become L1
 * observations, Decision becomes L1 decision, Escalation becomes L1
 * observation tagged escalation.
 *
 * Atom.derived_from chains every Position/Counter back to its
 * parent Question (and Counter to the Position it objects to) so
 * downstream consumers can walk the deliberation tree from the
 * final Decision/Escalation back to the originating prompt.
 */
export function createDeliberationSink(
  atomStore: AtomStore,
): DeliberationSink {
  return async (event: DeliberationEvent): Promise<void> => {
    const atom = deliberationEventToAtom(event);
    await atomStore.put(atom);
  };
}

export function deliberationEventToAtom(event: DeliberationEvent): Atom {
  switch (event.type) {
    case 'question':
      return questionToAtom(event);
    case 'position':
      return positionToAtom(event);
    case 'counter':
      return counterToAtom(event);
    case 'decision':
      return decisionToAtom(event);
    case 'escalation':
      return escalationToAtom(event);
  }
}

function baseAtomShape(
  id: string,
  content: string,
  authorPrincipal: string,
  createdAt: string,
): Omit<Atom, 'type' | 'layer' | 'provenance' | 'metadata'> {
  return {
    schema_version: 1,
    id: id as AtomId,
    content,
    confidence: 1,
    created_at: createdAt,
    last_reinforced_at: createdAt,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: authorPrincipal as PrincipalId,
    taint: 'clean',
  };
}

function questionToAtom(q: Question): Atom {
  return {
    ...baseAtomShape(q.id, q.prompt, q.authorPrincipal, q.created_at),
    type: 'question',
    layer: 'L1',
    provenance: {
      kind: 'agent-inferred',
      source: { agent_id: q.authorPrincipal },
      derived_from: [],
    },
    question_state: 'pending',
    metadata: {
      scope: [...q.scope],
      participants: [...q.participants],
      roundBudget: q.roundBudget,
      timeoutAt: q.timeoutAt,
    },
  };
}

function positionToAtom(p: Position): Atom {
  return {
    ...baseAtomShape(p.id, p.answer, p.authorPrincipal, p.created_at),
    type: 'observation',
    layer: 'L1',
    provenance: {
      kind: 'agent-inferred',
      source: { agent_id: p.authorPrincipal },
      derived_from: [p.inResponseTo as AtomId, ...p.derivedFrom.map((id) => id as AtomId)],
    },
    metadata: {
      kind: 'position',
      rationale: p.rationale,
      inResponseTo: p.inResponseTo,
    },
  };
}

function counterToAtom(c: Counter): Atom {
  return {
    ...baseAtomShape(c.id, c.objection, c.authorPrincipal, c.created_at),
    type: 'observation',
    layer: 'L1',
    provenance: {
      kind: 'agent-inferred',
      source: { agent_id: c.authorPrincipal },
      derived_from: [c.inResponseTo as AtomId, ...c.derivedFrom.map((id) => id as AtomId)],
    },
    metadata: {
      kind: 'counter',
      inResponseTo: c.inResponseTo,
    },
  };
}

function decisionToAtom(d: Decision): Atom {
  return {
    ...baseAtomShape(d.id, d.answer, d.authorPrincipal, d.created_at),
    type: 'decision',
    layer: 'L1',
    provenance: {
      kind: 'agent-inferred',
      source: { agent_id: d.authorPrincipal },
      derived_from: [d.resolving as AtomId],
    },
    metadata: {
      kind: 'decision',
      resolving: d.resolving,
      arbitrationTrace: d.arbitrationTrace,
    },
  };
}

function escalationToAtom(e: Escalation): Atom {
  return {
    ...baseAtomShape(e.id, e.reason, e.authorPrincipal, e.created_at),
    type: 'observation',
    layer: 'L1',
    provenance: {
      kind: 'agent-inferred',
      source: { agent_id: e.authorPrincipal },
      derived_from: [e.from as AtomId],
    },
    metadata: {
      kind: 'escalation',
      from: e.from,
      suggestedNext: e.suggestedNext,
      requiresHumanBy: e.requiresHumanBy,
    },
  };
}

// ---------------------------------------------------------------------------
// Reasoning sink: thinking blocks -> observation atoms
// ---------------------------------------------------------------------------

export function createReasoningSink(atomStore: AtomStore): ReasoningSink {
  return async (event: ReasoningEvent): Promise<void> => {
    const id = `reasoning-${event.principalId}-${event.questionId}-${event.emittedAt}`;
    const atom: Atom = {
      schema_version: 1,
      id: id as AtomId,
      content: event.thinking,
      type: 'observation',
      layer: 'L0',
      provenance: {
        kind: 'agent-observed',
        source: { agent_id: event.principalId },
        derived_from: [event.questionId as AtomId],
      },
      confidence: 1,
      created_at: event.emittedAt,
      last_reinforced_at: event.emittedAt,
      expires_at: null,
      supersedes: [],
      superseded_by: [],
      scope: 'session',
      signals: {
        agrees_with: [],
        conflicts_with: [],
        validation_status: 'unchecked',
        last_validated_at: null,
      },
      principal_id: event.principalId as PrincipalId,
      taint: 'clean',
      metadata: {
        kind: 'reasoning-step',
        signature: event.signature,
        inResponseTo: event.questionId,
      },
    };
    await atomStore.put(atom);
  };
}

// ---------------------------------------------------------------------------
// Canon renderer seam
// ---------------------------------------------------------------------------

/**
 * Adapt the pure `renderForPrincipal` function to the
 * CanonRendererForPrincipal shape agent-process expects. The
 * substrate renderer is given the full atom set once at startup;
 * calling renderFor({principal}) filters by the principal's
 * permitted_layers + role tag filter and returns the rendered
 * markdown as a string.
 */
export function createCanonRenderer(
  atoms: ReadonlyArray<Atom>,
): CanonRendererForPrincipal {
  return {
    renderFor({ principal }: { principal: Principal }): string {
      return renderForPrincipal({ principal, atoms });
    },
  };
}

// ---------------------------------------------------------------------------
// Top-level runner
// ---------------------------------------------------------------------------

export interface RunDeliberationOptions {
  readonly question: Question;
  readonly participants: ReadonlyArray<SeedPrincipal>;
  readonly atomStore: AtomStore;
  readonly principalStore: PrincipalStore;
  readonly anthropic: MessagesClient;
  readonly canonAtoms: ReadonlyArray<Atom>;
  /** Principal authoring the Decision / Escalation. Must be one of the participants. */
  readonly decidingPrincipal: string;
  readonly signal?: AbortSignal;
  /**
   * Depth of each participant from the root. Forwarded to the
   * arbitrator's source-rank tiebreak. If omitted, defaults to
   * computing depth from signed_by chains walked through
   * `principalStore`.
   */
  readonly principalDepths?: Readonly<Record<string, number>>;
  /**
   * When true, a Decision outcome is passed through `executeDecision`
   * and the resulting PrOpenedAtom (or ExecutionFailedAtom) is
   * persisted to the AtomStore and returned on `result.execution`.
   * An Escalation outcome never triggers execution regardless of
   * this flag.
   *
   * Default: false (deliberate-only). Execution is opt-in: a stray
   * invocation with no flag set must NOT attempt a PR. The task-D
   * dogfooding run surfaced the destructive default as a UX smell;
   * the safer posture is "observation by default, execution on
   * explicit opt-in." Callers that want the executor path must
   * pass `execute: true` together with `executorPrincipalId` + a
   * real `host`.
   */
  readonly execute?: boolean;
  /**
   * Principal id for the emitted PrOpenedAtom / ExecutionFailedAtom.
   * Required when execution is enabled (i.e. `execute !== false`).
   * Typically `vo-code-author`. Throws synchronously if omitted
   * while execution is enabled; we refuse to default this because
   * a non-virtual-org deployment that forgot the field would
   * silently attribute PRs to a principal that does not exist in
   * its PrincipalStore.
   */
  readonly executorPrincipalId?: string;
  /**
   * Real Host passed through to `executeDecision`. Required when
   * execution is enabled (i.e. `execute !== false`). The default
   * `runCodeAuthor` path reaches beyond `atoms` / `principals`
   * into notifier, scheduler, auditor, canon, clock, and llm, so
   * a partial Host fabricated from (atomStore, principalStore)
   * would NPE at the first sub-interface touch. Callers running
   * the memory-backed bootstrap can pass `createMemoryHost()`;
   * callers wiring a production adapter pass their real Host.
   * Throws synchronously if omitted while execution is enabled.
   */
  readonly host?: Host;
  /**
   * Injectable code-author fn; defaults to the real `runCodeAuthor`
   * from the actor-message primitive. Tests inject a mock so no
   * GitHub / git call happens under test.
   */
  readonly codeAuthorFn?: CodeAuthorFn;
}

export interface RunDeliberationResult {
  readonly outcome: Decision | Escalation;
  /**
   * Populated when the outcome is a Decision and `execute` was not
   * set to false. Undefined when the outcome is an Escalation or
   * execute was explicitly disabled.
   */
  readonly execution?: ExecuteDecisionResult;
}

export async function runDeliberation(
  opts: RunDeliberationOptions,
): Promise<RunDeliberationResult> {
  // Fail-fast validation for the execution path. We deliberately refuse
  // to default either field: a silent default for `executorPrincipalId`
  // would attribute PRs to a principal that may not exist in a caller's
  // PrincipalStore, and a fabricated partial Host for `host` would NPE
  // the moment the default `runCodeAuthor` reaches beyond atoms /
  // principals (notifier, scheduler, auditor, canon, clock, llm). Both
  // failures would surface only after an LLM round-trip; up-front
  // throws save the operator the latency and leave the error site
  // close to the misconfiguration. See CR #106 findings
  // PRRT_kwDOSGhm98589guF and PRRT_kwDOSGhm98589guJ.
  const executionRequested = opts.execute === true;
  if (executionRequested) {
    if (opts.executorPrincipalId === undefined) {
      throw new Error(
        '[runDeliberation] executorPrincipalId is required when execute: true. ' +
          'Pass the principal id that should author the PrOpenedAtom / ExecutionFailedAtom ' +
          '(typically "vo-code-author" for the virtual-org bootstrap), or omit execute ' +
          '(defaults to deliberate-only).',
      );
    }
    if (opts.host === undefined) {
      throw new Error(
        '[runDeliberation] host is required when execute: true. ' +
          'The default runCodeAuthor path reaches beyond atoms/principals into ' +
          'notifier/scheduler/auditor/canon/clock/llm; a partial Host will NPE. ' +
          'Pass createMemoryHost() for the memory-backed bootstrap, your real production ' +
          'Host, or omit execute (defaults to deliberate-only).',
      );
    }
  }

  const canonRenderer = createCanonRenderer(opts.canonAtoms);
  const sink = createDeliberationSink(opts.atomStore);
  const reasoningSink = createReasoningSink(opts.atomStore);

  const handles: Record<string, AgentHandle> = {};
  for (const seed of opts.participants) {
    const baseOptions = {
      principal: seed.principal,
      canonRenderer,
      anthropic: opts.anthropic,
      model: seed.model,
      reasoningSink,
    };
    const handleOptions = opts.signal !== undefined
      ? { ...baseOptions, signal: opts.signal }
      : baseOptions;
    handles[String(seed.principal.id)] = startAgent(handleOptions);
  }

  const depths = opts.principalDepths ?? (await computePrincipalDepths(
    opts.principalStore,
    opts.participants.map((s) => String(s.principal.id)),
  ));

  const outcome = await deliberate({
    question: opts.question,
    participants: handles,
    sink,
    decidingPrincipal: opts.decidingPrincipal,
    principalDepths: depths,
  });

  // Escalation outcomes never trigger execution; the soft-tier
  // human gate is the point. Decision outcomes flow through
  // executeDecision only when the caller explicitly opted in with
  // execute: true (deliberate-only is the default).
  const shouldExecute = outcome.type === 'decision' && opts.execute === true;
  if (!shouldExecute) {
    return { outcome };
  }

  // Both fields validated at the top of runDeliberation; by the time
  // we land here executionRequested === true, so non-null assertions
  // are safe. The upstream checks throw synchronously before any
  // LLM round-trip, so a misconfigured caller sees the error at
  // their call site rather than after deliberation.
  const executorPrincipalId = opts.executorPrincipalId!;
  const host = opts.host!;
  const executeArgs: Parameters<typeof executeDecision>[0] = {
    decision: outcome,
    question: opts.question,
    executorPrincipalId,
    host,
    ...(opts.codeAuthorFn !== undefined ? { codeAuthorFn: opts.codeAuthorFn } : {}),
  };

  const execution = await executeDecision(executeArgs);

  // Persist the execution atom via the existing AtomStore path so
  // downstream audit walkers find it alongside Question / Position
  // / Counter / Decision atoms. The pattern -> core-atom shape
  // mirrors `deliberationEventToAtom` so every emitter lands through
  // the same sink discipline.
  await opts.atomStore.put(executionAtomToCoreAtom(execution, opts.question.id));

  return { outcome, execution };
}

function executionAtomToCoreAtom(
  exec: ExecuteDecisionResult,
  questionId: string,
): Atom {
  const base = {
    schema_version: 1 as const,
    id: exec.id as AtomId,
    content: exec.content,
    type: 'observation' as const,
    layer: 'L1' as const,
    provenance: {
      kind: 'agent-observed' as const,
      source: { agent_id: exec.principal_id },
      derived_from: exec.derivedFrom.map((id) => id as AtomId),
    },
    confidence: 1,
    created_at: exec.created_at,
    last_reinforced_at: exec.created_at,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project' as const,
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked' as const,
      last_validated_at: null,
    },
    principal_id: exec.principal_id as PrincipalId,
    taint: 'clean' as const,
  };
  if (exec.kind === 'pr-opened') {
    return {
      ...base,
      metadata: {
        kind: 'pr-opened' as const,
        questionId,
      },
    };
  }
  return {
    ...base,
    metadata: {
      kind: 'execution-failed' as const,
      questionId,
    },
  };
}

// ---------------------------------------------------------------------------
// Default LLM backend selection
// ---------------------------------------------------------------------------

/**
 * Pick the default MessagesClient. The CLI client is the default so
 * the bootstrap runs without ANTHROPIC_API_KEY; the operator's existing
 * Claude Code OAuth install authenticates the subprocess.
 *
 * Override via LAG_LLM_BACKEND=sdk (plus ANTHROPIC_API_KEY) when the
 * caller wants plaintext reasoning blocks; CLI thinking is
 * signature-only per docs/claude-code-session-persistence.md.
 *
 * `sdkFactory` is an injection seam so callers can avoid a hard import
 * of `@anthropic-ai/sdk` inside a library. The boot.mjs entry point
 * passes a lazy factory; tests do not call this helper (they mock the
 * MessagesClient directly).
 */
export interface DefaultLlmClientOptions {
  readonly cliOptions?: CreateCliClientOptions;
  readonly sdkFactory?: () => MessagesClient;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export function defaultLlmClient(opts: DefaultLlmClientOptions = {}): MessagesClient {
  const env = opts.env ?? process.env;
  const backend = (env['LAG_LLM_BACKEND'] ?? 'cli').toLowerCase();
  if (backend === 'sdk') {
    if (!opts.sdkFactory) {
      throw new Error(
        '[boot-lib] LAG_LLM_BACKEND=sdk requires a sdkFactory in DefaultLlmClientOptions',
      );
    }
    return opts.sdkFactory();
  }
  return createCliClient(opts.cliOptions ?? {});
}

async function computePrincipalDepths(
  store: PrincipalStore,
  ids: ReadonlyArray<string>,
): Promise<Record<string, number>> {
  const depths: Record<string, number> = {};
  for (const id of ids) {
    let depth = 0;
    let current = await store.get(id as PrincipalId);
    // Cap at 16 to match substrate MAX_PRINCIPAL_DEPTH semantics; chains
    // deeper than that are operator errors, not runtime conditions.
    while (current && current.signed_by && depth < 16) {
      depth += 1;
      current = await store.get(current.signed_by);
    }
    depths[id] = depth;
  }
  return depths;
}

// ---------------------------------------------------------------------------
// parseBootArgs: fail-fast argv parser for boot.mjs.
//
// The virtual-org boot script used to default to the destructive
// execute path; the safety flip made deliberate-only the default and
// added `--execute` as an explicit opt-in. That flip broke any caller
// that still typed the retired `--deliberate-only` flag, and, worse,
// silently demoted any unknown `--*` token (including typos like
// `--excute`) into the positional prompt slot - burning an LLM run on
// nonsense input. This parser rejects unknown flags loudly and gives
// a migration hint for the retired one.
// ---------------------------------------------------------------------------

export interface ParseBootArgsResult {
  readonly execute: boolean;
  readonly prompt: string | undefined;
}

export function parseBootArgs(argv: ReadonlyArray<string>): ParseBootArgsResult {
  let execute = false;
  const positional: string[] = [];
  for (const a of argv) {
    if (a === '--execute') {
      execute = true;
    } else if (a === '--deliberate-only') {
      // Retired flag from the safety flip. Deliberate-only is now the
      // default; callers opt into execution with `--execute` instead.
      throw new Error(
        '[boot] --deliberate-only was removed; omit the flag for deliberate-only or pass --execute to opt into the executor path.',
      );
    } else if (a.startsWith('--')) {
      // Any other `--*` token is an unknown option. Demoting it to a
      // positional prompt would quietly run a wrong-input LLM call, so
      // fail fast with the offending token in the error.
      throw new Error(
        `[boot] unknown option: ${a}. Known flags: --execute. Omit for deliberate-only (the default).`,
      );
    } else {
      positional.push(a);
    }
  }
  return { execute, prompt: positional[0] };
}
