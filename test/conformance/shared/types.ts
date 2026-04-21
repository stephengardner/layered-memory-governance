/**
 * Shared conformance-spec types.
 *
 * Adapter-agnostic specs take a factory producing {host, cleanup} per test.
 * Adapter authors (and the test files) pass a factory; the spec runs every
 * case against a fresh host. Cleanup is optional (memory needs none; file
 * cleanup removes a tmp dir).
 */

import type { Host } from '../../../src/substrate/interface.js';

export interface ConformanceTarget {
  readonly host: Host;
  readonly cleanup?: () => Promise<void>;
}

export type TargetFactory = () => Promise<ConformanceTarget>;
