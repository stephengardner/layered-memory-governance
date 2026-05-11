/**
 * Integration tests for the Phase 3 registry-bridge against
 * `MemoryHost`-shaped state (PR #308).
 *
 * Acceptance criterion (per spec section 11.3 / brief):
 *   "Removing the `pol-resume-strategy-pr-fix-actor` atom from canon
 *    flips PrFix back to fresh-spawn."
 *
 * The bridge under test is `wrapAgentLoopAdapterIfEnabled`. Test
 * scenarios:
 *   1. Policy ABSENT (canon read returns undefined / null) →
 *      wrapper returns the fresh adapter unchanged. The fresh
 *      adapter's `run` is invoked directly; no resume attempt.
 *   2. Policy PRESENT + valid + enabled=true →
 *      wrapper returns a `ResumeAuthorAgentLoopAdapter` instance.
 *      The wrapped adapter's `run` calls the strategy ladder.
 *   3. Policy PRESENT + valid + enabled=false →
 *      wrapper returns the fresh adapter unchanged.
 *   4. Policy PRESENT + malformed (Zod fails) →
 *      wrapper returns the fresh adapter unchanged (fail-closed).
 *   5. Descriptor not registered → wrapper returns the fresh
 *      adapter unchanged regardless of policy.
 */

import { describe, it, expect } from 'vitest';
import {
  buildDefaultRegistry,
} from '../../../../examples/agent-loops/resume-author/default-registry.js';
import {
  PR_FIX_ACTOR_PRINCIPAL_ID,
} from '../../../../examples/agent-loops/resume-author/pr-fix-actor-strategy.js';
import {
  CODE_AUTHOR_PRINCIPAL_ID,
} from '../../../../examples/agent-loops/resume-author/code-author-strategy.js';
import {
  wrapAgentLoopAdapterIfEnabled,
  type RegistryHost,
  type PrincipalId as RegistryPrincipalId,
} from '../../../../examples/agent-loops/resume-author/registry.js';
import { ResumeAuthorAgentLoopAdapter } from '../../../../examples/agent-loops/resume-author/loop.js';
import { createMemoryHost } from '../../../../src/adapters/memory/index.js';
import type {
  AgentLoopAdapter,
  AgentLoopInput,
  AgentLoopResult,
} from '../../../../src/substrate/agent-loop.js';
import type { CandidateSession } from '../../../../examples/agent-loops/resume-author/types.js';
import type { AtomId } from '../../../../src/substrate/types.js';

/**
 * Stub fresh-spawn AgentLoopAdapter that records `run` calls so the
 * test can verify whether the wrapper passed through unchanged or
 * spawned a wrapped resume-aware adapter on top.
 */
class StubFreshAgentLoopAdapter implements AgentLoopAdapter {
  readonly capabilities = {
    tracks_cost: false,
    supports_signal: false,
    classify_failure: () => 'structural' as const,
  };
  readonly runCalls: AgentLoopInput[] = [];

  async run(input: AgentLoopInput): Promise<AgentLoopResult> {
    this.runCalls.push(input);
    return {
      kind: 'completed',
      sessionAtomId: 'session-stub' as AtomId,
      turnAtomIds: [],
    };
  }
}

/**
 * Construct a `RegistryHost` whose `canon.read` consults a Map of
 * pre-seeded policy payloads keyed by atom-id. Mirrors the shape
 * runner scripts use: a thin canon-read indirection over the host's
 * AtomStore, where the payload is `metadata.policy.content` from the
 * policy atom.
 */
function mkRegistryHost(opts: {
  readonly registryHost: ReturnType<typeof createMemoryHost>;
  readonly canonContents: Map<string, unknown>;
}): RegistryHost {
  const registry = buildDefaultRegistry(opts.registryHost);
  return {
    registry,
    canon: {
      read: (key: string) => {
        if (!opts.canonContents.has(key)) {
          // Mirrors `host.atoms.get(...) -> null`: the consumer treats
          // missing keys as policy disabled. Returning undefined here
          // routes through the bridge's `policyEnables(undefined)
          // -> false` path so the fresh adapter is returned unchanged.
          return undefined;
        }
        return opts.canonContents.get(key);
      },
    },
  };
}

const POLICY_ATOM_ID_PR_FIX = 'pol-resume-strategy-pr-fix-actor';

const dummyAssemble = async (_input: AgentLoopInput): Promise<ReadonlyArray<CandidateSession>> => [];

/**
 * Helper: invoke `wrapAgentLoopAdapterIfEnabled` with the canonical
 * test arguments. Eight test cases share the same six-line invocation
 * shape (fresh, pr-fix-actor principal, registry host, three opts);
 * extracting at N=2 per `dev-extract-helpers-at-n-2` keeps each test
 * focused on its own setup-and-assertion.
 */
function callWrap(
  fresh: AgentLoopAdapter,
  agentLoopHost: ReturnType<typeof createMemoryHost>,
  registryHost: RegistryHost,
): AgentLoopAdapter {
  return wrapAgentLoopAdapterIfEnabled(
    fresh,
    PR_FIX_ACTOR_PRINCIPAL_ID as unknown as RegistryPrincipalId,
    registryHost,
    {
      agentLoopHost,
      strategies: [],
      assembleCandidates: dummyAssemble,
    },
  );
}

describe('wrapAgentLoopAdapterIfEnabled (registry-integration)', () => {
  it('policy ABSENT in canon → returns fresh adapter unchanged (regression check vs PR #171)', () => {
    // The acceptance criterion: removing the
    // `pol-resume-strategy-pr-fix-actor` atom flips PR-fix back to
    // fresh-spawn. Encoded here as: a canon read that returns
    // undefined for the policy key MUST cause the bridge to return
    // the fresh adapter unchanged (capabilities and identity preserved).
    const host = createMemoryHost();
    const fresh = new StubFreshAgentLoopAdapter();
    const registryHost = mkRegistryHost({
      registryHost: host,
      canonContents: new Map(), // empty -> policy absent
    });

    const wrapped = callWrap(fresh, host, registryHost);
    expect(wrapped).toBe(fresh);
    expect(wrapped).not.toBeInstanceOf(ResumeAuthorAgentLoopAdapter);
  });

  it('policy PRESENT + enabled=true → returns a ResumeAuthorAgentLoopAdapter wrapping the fresh adapter', () => {
    const host = createMemoryHost();
    const fresh = new StubFreshAgentLoopAdapter();
    const registryHost = mkRegistryHost({
      registryHost: host,
      canonContents: new Map([
        [POLICY_ATOM_ID_PR_FIX, { enabled: true, max_stale_hours: 8 }],
      ]),
    });

    const wrapped = callWrap(fresh, host, registryHost);
    expect(wrapped).toBeInstanceOf(ResumeAuthorAgentLoopAdapter);
    expect(wrapped).not.toBe(fresh);
    // Capabilities are mirrored from the fresh adapter so consumers
    // see uniform behavior whether the wrap is composed in or not.
    expect(wrapped.capabilities).toBe(fresh.capabilities);
  });

  it('policy PRESENT + enabled=false → returns fresh adapter unchanged', () => {
    const host = createMemoryHost();
    const fresh = new StubFreshAgentLoopAdapter();
    const registryHost = mkRegistryHost({
      registryHost: host,
      canonContents: new Map([
        [POLICY_ATOM_ID_PR_FIX, { enabled: false }],
      ]),
    });

    expect(callWrap(fresh, host, registryHost)).toBe(fresh);
  });

  it('policy PRESENT but malformed (missing enabled) → fail-closed: returns fresh adapter unchanged', () => {
    const host = createMemoryHost();
    const fresh = new StubFreshAgentLoopAdapter();
    const registryHost = mkRegistryHost({
      registryHost: host,
      canonContents: new Map([
        // Missing the required `enabled` field; the Zod schema
        // rejects this and the fail-closed validator returns false.
        [POLICY_ATOM_ID_PR_FIX, { max_stale_hours: 8 }],
      ]),
    });

    expect(callWrap(fresh, host, registryHost)).toBe(fresh);
  });

  it('policy PRESENT but extra unknown field → fail-closed (strict schema)', () => {
    // The schema is `.strict()`: extra fields signal drift. A
    // tampered atom with `kill_switch: true` (or any unknown) MUST
    // NOT silently activate resume; the wrapper falls back to the
    // fresh adapter.
    const host = createMemoryHost();
    const fresh = new StubFreshAgentLoopAdapter();
    const registryHost = mkRegistryHost({
      registryHost: host,
      canonContents: new Map([
        [POLICY_ATOM_ID_PR_FIX, { enabled: true, kill_switch: true }],
      ]),
    });

    expect(callWrap(fresh, host, registryHost)).toBe(fresh);
  });

  it('descriptor NOT registered → returns fresh adapter unchanged regardless of policy', () => {
    // Even with a valid + enabled policy in canon, an unregistered
    // principal goes through the descriptor-not-found short-circuit.
    // This protects against a runner script that consults a registry
    // missing its expected descriptor. NOTE: this case uses a
    // ghost-actor principal that has no descriptor registered; we
    // call the bridge directly to override the principal.
    const host = createMemoryHost();
    const fresh = new StubFreshAgentLoopAdapter();
    const registryHost = mkRegistryHost({
      registryHost: host,
      canonContents: new Map([
        ['pol-resume-strategy-ghost-actor', { enabled: true }],
      ]),
    });

    const wrapped = wrapAgentLoopAdapterIfEnabled(
      fresh,
      'ghost-actor' as unknown as RegistryPrincipalId,
      registryHost,
      {
        agentLoopHost: host,
        strategies: [],
        assembleCandidates: dummyAssemble,
      },
    );
    expect(wrapped).toBe(fresh);
  });

  it('canon read throws → fail-closed: returns fresh adapter unchanged', () => {
    const host = createMemoryHost();
    const fresh = new StubFreshAgentLoopAdapter();
    const registry = buildDefaultRegistry(host);
    const throwingHost: RegistryHost = {
      registry,
      canon: {
        read: () => {
          throw new Error('atomstore offline');
        },
      },
    };

    expect(callWrap(fresh, host, throwingHost)).toBe(fresh);
  });

  it('removing the policy atom from canon flips back to fresh-spawn (acceptance criterion)', () => {
    // Direct simulation of the regression check: the wrapper IS
    // enabled with the policy present, and immediately returns to
    // fresh-spawn semantics when the policy is removed. Two calls
    // with different canon states; the `wrapped` adapters compare
    // for instance identity.
    const host = createMemoryHost();
    const fresh = new StubFreshAgentLoopAdapter();
    const canonStateA = new Map<string, unknown>([
      [POLICY_ATOM_ID_PR_FIX, { enabled: true, max_stale_hours: 8 }],
    ]);
    const canonStateB = new Map<string, unknown>(); // policy removed
    const hostA = mkRegistryHost({ registryHost: host, canonContents: canonStateA });
    const hostB = mkRegistryHost({ registryHost: host, canonContents: canonStateB });

    const wrappedA = callWrap(fresh, host, hostA);
    const wrappedB = callWrap(fresh, host, hostB);

    // With the policy present, the bridge produces a wrapped adapter
    // distinct from the fresh-spawn instance.
    expect(wrappedA).not.toBe(fresh);
    expect(wrappedA).toBeInstanceOf(ResumeAuthorAgentLoopAdapter);

    // With the policy removed, the bridge passes through the fresh
    // adapter by reference.
    expect(wrappedB).toBe(fresh);
  });
});

// ---------------------------------------------------------------------------
// Task #155: extend the registry-bridge tests to the code-author principal.
//
// The bridge is principal-keyed: the same wrapAgentLoopAdapterIfEnabled
// call honors a per-principal canon policy keyed by
// `pol-resume-strategy-<principal-id>`. The pr-fix-actor describe block
// above pins the wiring for pr-fix; this block pins the symmetric wiring
// for code-author so a substrate regression that breaks ONE descriptor
// fails its own test rather than masquerading as an unrelated change.
//
// Acceptance per task #155: removing the `pol-resume-strategy-code-author`
// atom flips code-author back to fresh-spawn (matches the pr-fix-actor
// regression check vs PR #171).
// ---------------------------------------------------------------------------

const POLICY_ATOM_ID_CODE_AUTHOR = 'pol-resume-strategy-code-author';

/**
 * Helper: mirror `callWrap` for the code-author principal. Extracted
 * per `dev-extract-helpers-at-n-2` so each code-author test focuses on
 * its assertion rather than the principal+opts boilerplate. The
 * descriptor's `assembleCandidates` is the registry-side concern; the
 * runner-side closure passed to `wrapAgentLoopAdapterIfEnabled` only
 * needs to be a no-op stub for the unwrap-or-wrap decision test.
 */
function callWrapCodeAuthor(
  fresh: AgentLoopAdapter,
  agentLoopHost: ReturnType<typeof createMemoryHost>,
  registryHost: RegistryHost,
): AgentLoopAdapter {
  return wrapAgentLoopAdapterIfEnabled(
    fresh,
    CODE_AUTHOR_PRINCIPAL_ID as unknown as RegistryPrincipalId,
    registryHost,
    {
      agentLoopHost,
      strategies: [],
      assembleCandidates: dummyAssemble,
    },
  );
}

describe('wrapAgentLoopAdapterIfEnabled (code-author principal, task #155)', () => {
  it('policy ABSENT in canon → returns fresh adapter unchanged (indie-floor default)', () => {
    // Acceptance: before task #155 ships its seed (or in any deployment
    // that deliberately removes the atom), the code-author dispatch
    // path must NOT silently wrap with resume. Empty canon -> fresh
    // adapter returned by reference.
    const host = createMemoryHost();
    const fresh = new StubFreshAgentLoopAdapter();
    const registryHost = mkRegistryHost({
      registryHost: host,
      canonContents: new Map(),
    });

    const wrapped = callWrapCodeAuthor(fresh, host, registryHost);
    expect(wrapped).toBe(fresh);
    expect(wrapped).not.toBeInstanceOf(ResumeAuthorAgentLoopAdapter);
  });

  it('policy PRESENT + enabled=true → returns a ResumeAuthorAgentLoopAdapter (task #155 seeded shape)', () => {
    // The task #155 seed lands max_stale_hours=4; the bridge does not
    // care about the value here (the schema validates it, the
    // SameMachineCliResumeStrategy consumes it). The contract this
    // test pins is: enabled=true + valid schema -> wrapped.
    const host = createMemoryHost();
    const fresh = new StubFreshAgentLoopAdapter();
    const registryHost = mkRegistryHost({
      registryHost: host,
      canonContents: new Map([
        [POLICY_ATOM_ID_CODE_AUTHOR, { enabled: true, max_stale_hours: 4 }],
      ]),
    });

    const wrapped = callWrapCodeAuthor(fresh, host, registryHost);
    expect(wrapped).toBeInstanceOf(ResumeAuthorAgentLoopAdapter);
    expect(wrapped).not.toBe(fresh);
    expect(wrapped.capabilities).toBe(fresh.capabilities);
  });

  it('policy PRESENT + enabled=false → returns fresh adapter unchanged', () => {
    // The explicit-disable shape: keeps the policy atom present (so
    // an operator-readable canon mention survives) but turns off the
    // wrap. Symmetric with the pr-fix-actor coverage above.
    const host = createMemoryHost();
    const fresh = new StubFreshAgentLoopAdapter();
    const registryHost = mkRegistryHost({
      registryHost: host,
      canonContents: new Map([
        [POLICY_ATOM_ID_CODE_AUTHOR, { enabled: false }],
      ]),
    });

    expect(callWrapCodeAuthor(fresh, host, registryHost)).toBe(fresh);
  });

  it('policy PRESENT but malformed (missing enabled) → fail-closed: returns fresh adapter unchanged', () => {
    // Fail-closed contract: a Zod-rejected payload does NOT silently
    // activate resume. The runner sees the fresh adapter; the
    // operator sees the malformed-policy log line at canon-read time.
    const host = createMemoryHost();
    const fresh = new StubFreshAgentLoopAdapter();
    const registryHost = mkRegistryHost({
      registryHost: host,
      canonContents: new Map([
        [POLICY_ATOM_ID_CODE_AUTHOR, { max_stale_hours: 4 }],
      ]),
    });

    expect(callWrapCodeAuthor(fresh, host, registryHost)).toBe(fresh);
  });

  it('removing the policy atom from canon flips back to fresh-spawn (task #155 acceptance criterion)', () => {
    // Direct simulation of the task #155 acceptance check: with the
    // policy present, the bridge produces a wrapped adapter; removing
    // the policy returns the fresh adapter by reference. Symmetric
    // with PR #171's pr-fix-actor regression check above.
    const host = createMemoryHost();
    const fresh = new StubFreshAgentLoopAdapter();
    const canonStateA = new Map<string, unknown>([
      [POLICY_ATOM_ID_CODE_AUTHOR, { enabled: true, max_stale_hours: 4 }],
    ]);
    const canonStateB = new Map<string, unknown>();
    const hostA = mkRegistryHost({ registryHost: host, canonContents: canonStateA });
    const hostB = mkRegistryHost({ registryHost: host, canonContents: canonStateB });

    const wrappedA = callWrapCodeAuthor(fresh, host, hostA);
    const wrappedB = callWrapCodeAuthor(fresh, host, hostB);

    expect(wrappedA).not.toBe(fresh);
    expect(wrappedA).toBeInstanceOf(ResumeAuthorAgentLoopAdapter);
    expect(wrappedB).toBe(fresh);
  });

  it('cross-principal isolation: a pr-fix policy in canon does NOT enable code-author wrapping', () => {
    // A canon state with the PR-fix atom present and the code-author
    // atom absent must NOT spill over: the bridge is principal-keyed,
    // so a deployment that opts into pr-fix resume but not code-author
    // resume sees fresh-spawn for code-author. This is the explicit
    // "raise the dial per principal" promise (a global toggle would
    // violate the indie-floor / org-ceiling spec).
    const host = createMemoryHost();
    const fresh = new StubFreshAgentLoopAdapter();
    const registryHost = mkRegistryHost({
      registryHost: host,
      canonContents: new Map([
        [POLICY_ATOM_ID_PR_FIX, { enabled: true, max_stale_hours: 8 }],
      ]),
    });

    // pr-fix DOES wrap (sanity check that the canon read is finding the
    // pr-fix entry).
    const wrappedPrFix = callWrap(fresh, host, registryHost);
    expect(wrappedPrFix).toBeInstanceOf(ResumeAuthorAgentLoopAdapter);

    // code-author does NOT wrap because the code-author atom is absent.
    const wrappedCodeAuthor = callWrapCodeAuthor(fresh, host, registryHost);
    expect(wrappedCodeAuthor).toBe(fresh);
  });
});
