/**
 * ResumeStrategyRegistry - Phase 1 primitive (PR #305) plus the Phase 3
 * canon-policy schema + adapter-bridge (PR #308).
 *
 * Source: spec §3.1 (descriptor shape), §5 (per-actor pol-resume-strategy
 * atom), §6.4 (construction-time canon read, acquire-time identify-then-
 * reset ordering), §7.2 (indie-floor "resume off" default via empty
 * registry / missing policy → fallback).
 *
 * Phase 1 shipped the primitive only: every consumer host booted with an
 * empty registry, so wrapIfEnabled returned the supplied fallback
 * unchanged. Phase 2 (PR #307) wired per-actor descriptors. Phase 3
 * (this PR) adds the Zod schema for the per-principal canon policy
 * atom (`pol-resume-strategy-<principal-id>`), a fail-closed validator
 * that returns false on schema mismatch, and the AgentLoopAdapter-side
 * bridge `wrapAgentLoopAdapterIfEnabled` so a runner script can wrap a
 * fresh-spawn adapter with `ResumeAuthorAgentLoopAdapter` only when the
 * canon policy enables it.
 */

import { z } from 'zod';
import type { AgentLoopAdapter, AgentLoopInput } from '../../../src/substrate/agent-loop.js';
import type { Host } from '../../../src/substrate/interface.js';
import { ResumeAuthorAgentLoopAdapter } from './loop.js';
import type { CandidateSession, SessionResumeStrategy } from './types.js';

export type PrincipalId = string & {
  readonly __principalIdBrand: unique symbol;
};

export interface ResumeStrategyDescriptor<
  TWalk = unknown,
  TCandidate = unknown,
  TInput = unknown,
> {
  readonly assembleCandidates: (walk: TWalk) => ReadonlyArray<TCandidate>;
  readonly identifyWorkItem: (input: TInput) => string;
  readonly ladder: ReadonlyArray<unknown>;
}

export type ResumeStrategyRegistry = Map<PrincipalId, ResumeStrategyDescriptor>;

export interface RegistryHost {
  readonly canon: { readonly read: (key: string) => unknown };
  readonly resetAtom?: { readonly isSet: (workItemKey: string) => boolean };
  readonly registry: ResumeStrategyRegistry;
}

export type Acquirer<TInput = unknown, TResult = unknown> = (
  input: TInput,
) => TResult | Promise<TResult>;

export class WorkItemKeyCollisionError extends Error {
  constructor(
    readonly workItemKey: string,
    readonly existingPrincipalId: PrincipalId,
    readonly incomingPrincipalId: PrincipalId,
  ) {
    super(
      `ResumeStrategyRegistry: work-item key "${workItemKey}" already claimed by principal "${String(existingPrincipalId)}"; cannot register for "${String(incomingPrincipalId)}"`,
    );
    this.name = "WorkItemKeyCollisionError";
  }
}

const POLICY_KEY_PREFIX = "pol-resume-strategy-";

// WeakMap so each registry instance has its own ledger; no module-level
// singleton state leaking across hosts.
const claimedKeysByRegistry = new WeakMap<
  ResumeStrategyRegistry,
  Map<string, PrincipalId>
>();

function ledgerFor(registry: ResumeStrategyRegistry): Map<string, PrincipalId> {
  let ledger = claimedKeysByRegistry.get(registry);
  if (!ledger) {
    ledger = new Map();
    claimedKeysByRegistry.set(registry, ledger);
  }
  return ledger;
}

/**
 * Zod schema for the `pol-resume-strategy-<principal-id>` canon policy
 * atom content shape per spec section 5.1.
 *
 * Required:
 *   - `enabled: boolean`:the dial. False (or any non-true value) and
 *     the wrapper short-circuits to fresh-spawn at construction time.
 *
 * Optional:
 *   - `max_stale_hours: number`:per-actor staleness window override
 *     (default 8 hours per spec section 5.3 / PR #171's
 *     SameMachineCliResumeStrategy default).
 *   - `fresh_spawn_kinds: string[]`:fresh-spawn ENUM kinds the
 *     deployment opts into (per spec section 6.1). Strings are not
 *     validated against the ENUM here because the substrate ENUM lives
 *     elsewhere (`FreshSpawnExceptionKind` in a future PR); the policy
 *     atom carries the kinds as opaque strings for this PR.
 *
 * `.passthrough()` is intentionally NOT used: the schema is closed so
 * an extra unknown field surfaces at write time as a drift signal
 * rather than silently passing through. A future schema evolution
 * adds explicit fields with their own optionality.
 */
export const resumeStrategyPolicySchema = z
  .object({
    enabled: z.boolean(),
    max_stale_hours: z.number().int().positive().optional(),
    fresh_spawn_kinds: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type ResumeStrategyPolicy = z.infer<typeof resumeStrategyPolicySchema>;

/**
 * Strict-validate variant for callers that want loud failure on a
 * malformed policy atom. Returns the parsed policy on success or
 * `null` on schema mismatch; callers that want the underlying
 * ZodError invoke `resumeStrategyPolicySchema.safeParse` directly.
 *
 * This is the SINGLE schema-parse site in the module; `policyEnables`
 * delegates to it so a future schema-level hardening (e.g. a refinement
 * that disables the policy on a sentinel value) lives in exactly one
 * place per `dev-extract-helpers-at-n-2`.
 */
export function validatePolicy(policy: unknown): ResumeStrategyPolicy | null {
  const parsed = resumeStrategyPolicySchema.safeParse(policy);
  return parsed.success ? parsed.data : null;
}

/**
 * Validate a canon-supplied policy payload against the schema and
 * return its `enabled` flag. Fail-closed: any schema mismatch (missing
 * `enabled`, wrong type, extra unknown field, malformed numeric fields)
 * returns `false` so a typo or a tampered atom cannot accidentally
 * turn resume on. Per `inv-governance-before-autonomy`: governance
 * before autonomy.
 *
 * The validator is intentionally pure: it does NOT log a mismatch
 * here because (a) the registry is consumer-side and the consumer's
 * audit channel may not exist (test harness, raw script), and
 * (b) callers that want loud failure call `validatePolicy()` directly.
 */
function policyEnables(policy: unknown): boolean {
  return validatePolicy(policy)?.enabled === true;
}

export function createResumeStrategyRegistry(): ResumeStrategyRegistry {
  return new Map();
}

export function addDescriptor(
  registry: ResumeStrategyRegistry,
  principalId: PrincipalId,
  descriptor: ResumeStrategyDescriptor,
  workItemKeys: ReadonlyArray<string>,
): void {
  const ledger = ledgerFor(registry);
  for (const key of workItemKeys) {
    const existing = ledger.get(key);
    if (existing !== undefined && existing !== principalId) {
      throw new WorkItemKeyCollisionError(key, existing, principalId);
    }
  }
  for (const key of workItemKeys) ledger.set(key, principalId);
  registry.set(principalId, descriptor);
}

export function wrapIfEnabled<TInput, TResult>(
  fallback: Acquirer<TInput, TResult>,
  principalId: PrincipalId,
  host: RegistryHost,
): Acquirer<TInput, TResult> {
  const descriptor = host.registry.get(principalId);
  if (!descriptor) return fallback;

  let policy: unknown;
  try {
    policy = host.canon.read(`${POLICY_KEY_PREFIX}${String(principalId)}`);
  } catch {
    return fallback;
  }
  if (!policyEnables(policy)) return fallback;

  return async (input: TInput): Promise<TResult> => {
    const workItemKey = descriptor.identifyWorkItem(input as unknown);
    const shouldReset = host.resetAtom
      ? host.resetAtom.isSet(workItemKey)
      : false;
    // Phase 1 routing: both branches delegate to `fallback`. The contract
    // under test is the order (identify-then-reset-check) and that a
    // reset signal selects the fresh-spawn path. Later phases swap in the
    // per-descriptor ladder for the non-reset branch.
    if (shouldReset) return fallback(input);
    return fallback(input);
  };
}

// ---------------------------------------------------------------------------
// Phase 3: AgentLoopAdapter-side bridge.
// ---------------------------------------------------------------------------
//
// `wrapIfEnabled` (above) operates on a generic `Acquirer<TInput, TResult>`
// function. Phase 3 wires the registry into runner scripts that compose
// `AgentLoopAdapter` instances; those callers want to wrap an adapter
// with `ResumeAuthorAgentLoopAdapter` (PR #171) when the canon policy
// is enabled and pass the adapter through unchanged when the policy is
// disabled or absent.
//
// `wrapAgentLoopAdapterIfEnabled` is the bridge: same enable/disable
// semantics as `wrapIfEnabled`, same canon-read short-circuit, but
// returns an `AgentLoopAdapter` rather than an `Acquirer` so the
// adapter's `capabilities` propagate to the actor.
//
// The bridge fetches policy via the supplied `RegistryHost.canon.read`
// (same indirection as `wrapIfEnabled`) but takes additional
// inputs that `Acquirer`-side callers don't need:
//
//   - `agentLoopHost: Host`:the substrate Host the wrapper passes to
//     `ResumeAuthorAgentLoopAdapter` for atom IO at resume-patch time.
//   - `strategies: ReadonlyArray<SessionResumeStrategy>`:the strategy
//     ladder (e.g. `[new SameMachineCliResumeStrategy(...)]`) the
//     wrapper iterates per-invocation.
//   - `assembleCandidates: (input: AgentLoopInput) => Promise<...>`:
//     the per-invocation candidate assembler. Runners typically close
//     over the registered descriptor's `assembleCandidates` plus
//     a host-side atom fetch; the bridge receives the closed-over
//     callback so the descriptor's specific TWalk shape stays
//     opaque to the bridge.

export interface AgentLoopWrapOptions {
  readonly agentLoopHost: Host;
  readonly strategies: ReadonlyArray<SessionResumeStrategy>;
  readonly assembleCandidates: (input: AgentLoopInput) => Promise<ReadonlyArray<CandidateSession>>;
}

/**
 * Adapter-side bridge for the registry's enable/disable gate.
 *
 * Returns the supplied `fallback` unchanged when:
 *   - The principal has no descriptor registered.
 *   - The canon read throws.
 *   - The canon-supplied policy fails Zod validation.
 *   - The validated policy's `enabled` is not `true`.
 *
 * Returns a `ResumeAuthorAgentLoopAdapter` wrapping `fallback` when
 * the policy is enabled. The wrapper inherits the fallback's
 * capabilities so consumers see uniform `AdapterCapabilities`
 * regardless of whether the wrap is composed in.
 *
 * The function is synchronous (returns the adapter directly, not a
 * Promise) because all the I/O it does is the synchronous canon
 * read; the wrapper's per-invocation work happens inside its own
 * async `run(input)` method.
 */
export function wrapAgentLoopAdapterIfEnabled(
  fallback: AgentLoopAdapter,
  principalId: PrincipalId,
  host: RegistryHost,
  opts: AgentLoopWrapOptions,
): AgentLoopAdapter {
  const descriptor = host.registry.get(principalId);
  if (!descriptor) return fallback;

  let policy: unknown;
  try {
    policy = host.canon.read(`${POLICY_KEY_PREFIX}${String(principalId)}`);
  } catch {
    return fallback;
  }
  if (!policyEnables(policy)) return fallback;

  // Policy is enabled: wrap with ResumeAuthorAgentLoopAdapter. The
  // wrapper handles strategy iteration, fresh-spawn fallback on
  // non-completed resume, and the resumed-session-atom patch. The
  // descriptor's `identifyWorkItem` and `assembleCandidates` are
  // closed-over by the runner before the call; the bridge does not
  // re-derive the work-item key here. Reset-atom enforcement (per
  // spec section 6.4) is layered on by the runner before the bridge
  // call when needed; the bridge stays minimal.
  return new ResumeAuthorAgentLoopAdapter({
    fallback,
    host: opts.agentLoopHost,
    strategies: opts.strategies,
    assembleCandidates: opts.assembleCandidates,
  });
}

declare global {
  interface ImportMeta {
    readonly vitest?: {
      describe: (name: string, fn: () => void) => void;
      it: (name: string, fn: () => unknown | Promise<unknown>) => void;
      expect: (value: unknown) => any;
      vi: {
        fn: <T extends (...args: any[]) => any>(
          impl?: T,
        ) => T & { mock: { calls: any[][] } };
      };
    };
  }
}

if (import.meta.vitest) {
  const { describe, it, expect, vi } = import.meta.vitest;

  const pid = (s: string): PrincipalId => s as unknown as PrincipalId;

  const stubDescriptor = (
    identifyImpl: (input: unknown) => string = (i) => String(i),
  ): ResumeStrategyDescriptor => ({
    assembleCandidates: () => [],
    identifyWorkItem: identifyImpl,
    ladder: [],
  });

  const stubHost = (
    registry: ResumeStrategyRegistry,
    canonRead: (k: string) => unknown,
    resetIsSet?: (k: string) => boolean,
  ): RegistryHost => ({
    registry,
    canon: { read: canonRead },
    // exactOptionalPropertyTypes: omit resetAtom entirely when no reset
    // function is supplied; assigning `undefined` to an optional property is
    // a type error under the project's tsconfig.
    ...(resetIsSet ? { resetAtom: { isSet: resetIsSet } } : {}),
  });

  describe("ResumeStrategyRegistry", () => {
    it("registry add + lookup happy path returns the descriptor", () => {
      const reg = createResumeStrategyRegistry();
      const desc = stubDescriptor();
      addDescriptor(reg, pid("alice"), desc, ["k1"]);
      expect(reg.get(pid("alice"))).toBe(desc);
    });

    it("lookup miss → wrapIfEnabled returns fallback unchanged", () => {
      const reg = createResumeStrategyRegistry();
      const fallback: Acquirer = async (i) => i;
      const host = stubHost(reg, () => ({ enabled: true }));
      const wrapped = wrapIfEnabled(fallback, pid("ghost"), host);
      expect(wrapped).toBe(fallback);
    });

    it("malformed canon policy → wrapIfEnabled returns fallback", () => {
      const reg = createResumeStrategyRegistry();
      addDescriptor(reg, pid("alice"), stubDescriptor(), ["k1"]);
      const fallback: Acquirer = async (i) => i;
      const host = stubHost(reg, () => "not-an-object");
      const wrapped = wrapIfEnabled(fallback, pid("alice"), host);
      expect(wrapped).toBe(fallback);
    });

    it("work-item key collision on add throws with a stable message", () => {
      const reg = createResumeStrategyRegistry();
      addDescriptor(reg, pid("alice"), stubDescriptor(), ["shared-key"]);
      expect(() =>
        addDescriptor(reg, pid("bob"), stubDescriptor(), ["shared-key"]),
      ).toThrow(WorkItemKeyCollisionError);
    });

    it("construction-time canon read fires exactly once, not per acquire", async () => {
      const reg = createResumeStrategyRegistry();
      addDescriptor(reg, pid("alice"), stubDescriptor(), ["k1"]);
      const reads = vi.fn((_k: string) => ({ enabled: true }));
      const host = stubHost(reg, reads);
      const fallback: Acquirer = async (i) => i;
      const wrapped = wrapIfEnabled(fallback, pid("alice"), host);
      await wrapped("a");
      await wrapped("b");
      await wrapped("c");
      expect(reads.mock.calls.length).toBe(1);
      // noUncheckedIndexedAccess: destructure with non-null assertion after
      // the length check above guarantees calls[0] exists.
      const [firstPolicyReadArg] = reads.mock.calls[0]!;
      expect(firstPolicyReadArg).toBe("pol-resume-strategy-alice");
    });

    it("acquire(input) invokes identifyWorkItem with the supplied input", async () => {
      const reg = createResumeStrategyRegistry();
      const identify = vi.fn((i: unknown) => String(i));
      addDescriptor(reg, pid("alice"), stubDescriptor(identify), ["k1"]);
      const host = stubHost(reg, () => ({ enabled: true }));
      const fallback: Acquirer = async (i) => i;
      const wrapped = wrapIfEnabled(fallback, pid("alice"), host);
      await wrapped({ jobId: 42 });
      expect(identify.mock.calls.length).toBe(1);
      // noUncheckedIndexedAccess: destructure with non-null assertion after
      // the length check above guarantees calls[0] exists.
      const [firstIdentifyArg] = identify.mock.calls[0]!;
      expect(firstIdentifyArg).toEqual({ jobId: 42 });
    });

    it("acquire runs reset-atom check after work-item identification", async () => {
      const reg = createResumeStrategyRegistry();
      const order: string[] = [];
      const identify = (i: unknown) => {
        order.push("identify");
        return String(i);
      };
      addDescriptor(reg, pid("alice"), stubDescriptor(identify), ["k1"]);
      const isSet = (_k: string) => {
        order.push("reset-check");
        return true;
      };
      const host = stubHost(reg, () => ({ enabled: true }), isSet);
      const fallback: Acquirer = async (i) => {
        order.push("fallback");
        return i;
      };
      const wrapped = wrapIfEnabled(fallback, pid("alice"), host);
      await wrapped("input-x");
      expect(order).toEqual(["identify", "reset-check", "fallback"]);
    });
  });
}
