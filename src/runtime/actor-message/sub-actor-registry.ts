/**
 * SubActorRegistry: the delegation seam between an approving actor
 * and an invokable sub-actor.
 *
 * A plan approved by an upstream actor can declare a sub-actor it
 * wants to invoke via `metadata.delegation.sub_actor_principal_id`.
 * The plan-dispatch loop scans for such approved plans and calls
 * `registry.invoke(principalId, payload, correlationId)`; the
 * registered invoker runs the sub-actor and returns whatever result
 * atoms it produced.
 *
 * Design notes:
 * - Register at bootstrap time, invoke at tick time. The registry
 *   does not own lifecycle; consumers register once and never unregister.
 *   This keeps the seam simple and avoids the "where does the actor
 *   live?" lifecycle question we don't want to answer in V1.
 * - The invoker returns an InvokeResult synchronously once the work
 *   completes; for long-running consumers, the invoker can return
 *   immediately with `kind: 'dispatched'` and emit its own result
 *   atoms later. V1 keeps both shapes in the result union for
 *   forward-compatibility.
 * - Unregistered principalId triggers a ValidationError. The caller
 *   turns that into an escalation atom via the deployment's
 *   configured escalation-policy path; the registry itself stays
 *   mechanism-only.
 */

import { ValidationError } from '../../errors.js';
import type { PrincipalId } from '../../types.js';

/**
 * Result shape from a sub-actor invocation. Discriminated union so
 * synchronous completion and fire-and-forget dispatch are both
 * first-class at the type level.
 */
export type InvokeResult =
  | {
      readonly kind: 'completed';
      /** Atom ids the sub-actor produced during this invocation. */
      readonly producedAtomIds: ReadonlyArray<string>;
      /** Short summary for audit; operator sees this in lag-inbox. */
      readonly summary: string;
    }
  | {
      readonly kind: 'dispatched';
      /**
       * Result atoms will land asynchronously; the caller matches
       * them by correlation_id. V1 does not ship a built-in reaper;
       * the integration test polls for completion.
       */
      readonly summary: string;
    }
  | {
      readonly kind: 'error';
      readonly message: string;
    };

/**
 * Invoker function shape. Takes an opaque payload + correlation_id,
 * returns a result. The payload schema is per-actor; the registry
 * does not type it beyond `unknown`.
 */
export type SubActorInvoker = (
  payload: unknown,
  correlationId: string,
) => Promise<InvokeResult>;

export class SubActorRegistry {
  private readonly invokers = new Map<string, SubActorInvoker>();

  /**
   * Register an invoker for a sub-actor principal. Idempotent when
   * called with the same invoker reference; throws if a different
   * invoker is registered under an existing id (drift = load-bearing
   * bug).
   */
  register(principalId: PrincipalId | string, invoker: SubActorInvoker): void {
    const key = String(principalId);
    const existing = this.invokers.get(key);
    if (existing !== undefined && existing !== invoker) {
      throw new Error(
        `SubActorRegistry.register: principal ${key} already has a different invoker. `
        + 'Unregister first or use a fresh registry instance.',
      );
    }
    this.invokers.set(key, invoker);
  }

  /** Whether a principal is registered. Useful for pre-dispatch escalation. */
  has(principalId: PrincipalId | string): boolean {
    return this.invokers.has(String(principalId));
  }

  /** List registered principal ids. For lag-inbox and audit surfaces. */
  list(): ReadonlyArray<string> {
    return Array.from(this.invokers.keys()).sort();
  }

  /**
   * Invoke the registered sub-actor. Unregistered -> ValidationError;
   * the caller typically converts that into an escalation atom so the
   * operator sees "attempted to delegate to X, X not registered."
   *
   * Invoker errors are wrapped into an `InvokeResult` of kind 'error'
   * rather than propagated; the plan-dispatch loop records the error
   * shape + summary so failed dispatches are visible to the operator
   * without crashing the loop.
   */
  async invoke(
    principalId: PrincipalId | string,
    payload: unknown,
    correlationId: string,
  ): Promise<InvokeResult> {
    const invoker = this.invokers.get(String(principalId));
    if (invoker === undefined) {
      throw new ValidationError(
        `SubActorRegistry.invoke: principal ${String(principalId)} is not registered. `
        + 'Register via SubActorRegistry.register() at bootstrap; '
        + `known principals: ${this.list().join(', ') || '(none)'}`,
      );
    }
    try {
      return await invoker(payload, correlationId);
    } catch (err) {
      return {
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
