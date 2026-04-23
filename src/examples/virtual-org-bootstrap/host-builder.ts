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

export interface BuildVirtualOrgHostOptions {
  /** Root directory under which every file-backed store persists. */
  readonly stateDir: string;
  /** Real or mock LLM. Required; the builder does not pick a default. */
  readonly llm: LLM;
  /**
   * Principal id recorded as `principal_id` on the seeded fence atoms.
   * Matches the `LAG_OPERATOR_ID` env var convention from
   * scripts/bootstrap-code-author-canon.mjs so the example runtime and
   * the bootstrap script converge on the same principal.
   */
  readonly operatorPrincipalId: PrincipalId;
  /**
   * When true, fence seeding is skipped. Useful for tests that want to
   * assert pre-seed state or that seed via a different code path.
   * Defaults to false (seeding on).
   */
  readonly skipSeed?: boolean;
}

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
  const fileHost: FileHost = await createFileHost({
    rootDir: opts.stateDir,
    llm: opts.llm,
  });

  if (!opts.skipSeed) {
    await seedFenceAtoms(fileHost.atoms, opts.operatorPrincipalId);
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
