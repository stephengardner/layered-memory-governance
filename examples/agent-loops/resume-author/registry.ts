/**
 * ResumeStrategyRegistry - Phase 1 primitive (PR #301).
 *
 * Source: spec §3.1 (descriptor shape), §6.4 (construction-time canon read,
 * acquire-time identify-then-reset ordering), §7.2 (indie-floor "resume off"
 * default via empty registry / missing policy → fallback).
 *
 * Phase 1 ships the primitive only: every consumer host boots with an empty
 * registry, so wrapIfEnabled returns the supplied fallback unchanged. Later
 * phases wire actual descriptors and run the ladder.
 */

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

function policyEnables(policy: unknown): boolean {
  if (policy === null || typeof policy !== "object") return false;
  const enabled = (policy as { enabled?: unknown }).enabled;
  return enabled === true;
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
    // under test is the order — identify-then-reset-check — and that a
    // reset signal selects the fresh-spawn path. Later phases swap in the
    // per-descriptor ladder for the non-reset branch.
    if (shouldReset) return fallback(input);
    return fallback(input);
  };
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
