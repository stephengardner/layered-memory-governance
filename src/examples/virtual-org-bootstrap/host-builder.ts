/**
 * Virtual-org Host composer.
 *
 * Assembles the 8-interface Host from `createFileHost` (atoms, canon,
 * auditor, clock, notifier, principals, scheduler) + a caller-supplied
 * LLM, then seeds the blast-radius fence atoms. The caller-facing option
 * is `stateDir`; `createFileHost` itself names the same path `rootDir`,
 * and the builder translates at the boundary.
 *
 * The builder takes an `LLM` by value rather than constructing one so
 * the LLM adapter stays pluggable at the example layer (CLI, stub, or a
 * mock). Fence seeding is on by default and skippable via `skipSeed`
 * for tests that want to assert post-seeding state deterministically.
 */

import { createFileHost, type FileHost } from '../../adapters/file/index.js';
import type { Host, LLM } from '../../substrate/interface.js';
import type { PrincipalId } from '../../substrate/types.js';
import { seedFenceAtoms } from './fence-seed.js';

interface BuildVirtualOrgHostBaseOptions {
  /** Root directory under which every file-backed store persists. */
  readonly stateDir: string;
  /** Real or mock LLM. Required; the builder does not pick a default. */
  readonly llm: LLM;
}

/**
 * Options for `buildVirtualOrgHost`. Discriminated on `skipSeed`:
 *
 *   - default (`skipSeed: false` or unset): `operatorPrincipalId` is
 *     required so the fence atoms are stamped with a real operator
 *     identity.
 *   - `skipSeed: true`: `operatorPrincipalId` is unused, therefore
 *     optional. A test that just wants the Host assembled does not
 *     need to invent a dummy operator id.
 *
 * The discriminated union makes the missing-operator case a type
 * error when seeding is on; the runtime guard at the top of the
 * builder handles untyped JS consumers that slip past the type check.
 */
export type BuildVirtualOrgHostOptions =
  | (BuildVirtualOrgHostBaseOptions & {
    /**
     * Principal id recorded as `principal_id` on the seeded fence
     * atoms. Matches the `LAG_OPERATOR_ID` env var convention from
     * the canon bootstrap script so the example runtime and the
     * bootstrap script converge on the same principal.
     */
    readonly operatorPrincipalId: PrincipalId;
    readonly skipSeed?: false;
  })
  | (BuildVirtualOrgHostBaseOptions & {
    /**
     * When true, fence seeding is skipped. Useful for tests that
     * want to assert pre-seed state or that seed via a different
     * code path.
     */
    readonly skipSeed: true;
    readonly operatorPrincipalId?: PrincipalId;
  });

export interface BuiltVirtualOrgHost {
  readonly host: Host;
  /** Release file handles + any other per-build resources. Idempotent. */
  close(): Promise<void>;
}

/**
 * Build a Host for the virtual-org example. Seeds the blast-radius
 * fence atoms by default; idempotent across rebuilds against the same
 * stateDir.
 */
export async function buildVirtualOrgHost(
  opts: BuildVirtualOrgHostOptions,
): Promise<BuiltVirtualOrgHost> {
  // Runtime guards for untyped callers (dynamic-dispatch JS consumers,
  // tests that cast the options bag). A missing llm must NOT fall
  // through to createFileHost's default stub: the virtual-org path
  // runs real LLM-backed deliberation and a silent stub would swap in
  // an LLM that rejects every call. A missing operatorPrincipalId
  // when seeding is on would stamp fence atoms with `undefined`
  // principal, corrupting the authority grant. Throw before any
  // file-system work so the operator sees a stack frame close to
  // their call site.
  if (opts.llm === undefined || opts.llm === null) {
    throw new Error(
      'buildVirtualOrgHost requires opts.llm; pass a real or mock LLM. The builder does not fall through to a default stub.',
    );
  }
  if (!opts.skipSeed && !opts.operatorPrincipalId) {
    throw new Error(
      'buildVirtualOrgHost requires opts.operatorPrincipalId when skipSeed is not true. '
      + 'Pass the operator principal id that should author the fence atoms, '
      + 'or set skipSeed: true to skip fence seeding entirely.',
    );
  }

  const fileHost: FileHost = await createFileHost({
    rootDir: opts.stateDir,
    llm: opts.llm,
  });

  if (!opts.skipSeed) {
    // Non-null assertion safe: the guard above throws when seeding is
    // on and the id is missing.
    await seedFenceAtoms(fileHost.atoms, opts.operatorPrincipalId!);
  }

  let closed = false;
  return {
    host: fileHost,
    async close() {
      if (closed) return;
      closed = true;
      // FileHost exposes no close seam today; file stores rely on
      // atomic rename + per-operation reads, so there's nothing to
      // release. Kept as an explicit lifecycle hook so later adapter
      // work (fd pooling, sqlite-backed variants) has a place to land.
    },
  };
}
