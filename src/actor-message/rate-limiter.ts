/**
 * Write-time rate limiter + circuit breaker for actor-message atoms.
 *
 * Sits between a caller and `host.atoms.put()`. Every write of an
 * `actor-message` atom runs through `checkWrite(principalId)`:
 *
 *   1. If the principal has an unresolved circuit-breaker trip, the
 *      write is rejected (CircuitBreakerOpenError). The trip only
 *      clears when a matching `circuit-breaker-reset` atom supersedes it.
 *   2. Otherwise, a token-bucket check runs against the principal's
 *      effective pol-actor-message-rate policy (default plus any
 *      per-principal override). On success the bucket is debited and
 *      the write proceeds.
 *   3. On bucket denial, a denial event is recorded in an in-memory
 *      per-principal ring buffer. If `denial_count_trip_threshold`
 *      denials have occurred inside `window_ms`, a new
 *      `circuit-breaker-trip` atom is written and the write is
 *      rejected with CircuitBreakerOpenError; otherwise
 *      RateLimitedError is thrown without tripping.
 *
 * In-memory state: bucket tokens per principal + denial timestamps
 * per principal. Both are reset across process restarts; that is
 * acceptable because the durable governance surface is the trip
 * atom itself (the "this principal is currently locked out" state
 * survives restart via the AtomStore), and the bucket is a soft
 * rate limit whose inaccuracy at restart cannot let a runaway
 * past the trip.
 *
 * Consumer API: `new ActorMessageRateLimiter(host)` and then
 * `await limiter.checkWrite(atom, principalId)` before each
 * `host.atoms.put(atom)`. The limiter reads policy atoms at
 * construction time and on an optional refresh hook; there is no
 * hidden global state.
 */

import {
  TransientError,
  ValidationError,
} from '../substrate/errors.js';
import type { Host } from '../substrate/interface.js';
import type { Atom, AtomFilter, PrincipalId, Time } from '../substrate/types.js';

/**
 * Thrown when a write is denied by the token bucket. Transient because
 * a later call (after a refill interval) may succeed; callers should
 * back off and retry, not treat this as a permanent failure.
 */
export class RateLimitedError extends TransientError {
  override readonly name = 'RateLimitedError';
  override readonly kind = 'rate_limited';
  constructor(
    readonly principal: PrincipalId,
    readonly tokensPerMinute: number,
    message?: string,
  ) {
    super(message ?? `write denied: principal ${String(principal)} exceeded ${tokensPerMinute} tokens/min bucket`);
  }
}

/**
 * Thrown when a principal has an unresolved circuit-breaker trip.
 * Validation-class because this is a deliberate policy decision, not
 * a transient condition; the caller must cause a reset atom to be
 * written (by an authorized principal) to proceed.
 */
export class CircuitBreakerOpenError extends ValidationError {
  override readonly name = 'CircuitBreakerOpenError';
  override readonly kind = 'circuit_breaker_open';
  constructor(
    readonly principal: PrincipalId,
    readonly tripAtomId: string,
    message?: string,
  ) {
    super(message ?? `write denied: principal ${String(principal)} is circuit-breaker-tripped (${tripAtomId})`);
  }
}

interface BucketState {
  /** Remaining tokens at `last_refill_ms`. */
  tokens: number;
  /** ms since epoch of the last refill. */
  last_refill_ms: number;
}

interface RateConfig {
  readonly tokens_per_minute: number;
  readonly burst_capacity: number;
}

interface CircuitConfig {
  readonly denial_count_trip_threshold: number;
  readonly window_ms: number;
  /** null means operator-signed reset required. Positive ms = auto-reset. */
  readonly automatic_reset_after_ms: number | null;
}

/**
 * Default configs as a last-resort fallback when the policy atoms are
 * missing. Bootstrap scripts seed them; consumers that skipped the
 * bootstrap still get sane defaults rather than a crash.
 */
const FALLBACK_RATE: RateConfig = { tokens_per_minute: 10, burst_capacity: 20 };
const FALLBACK_CIRCUIT: CircuitConfig = {
  denial_count_trip_threshold: 3,
  window_ms: 300_000,
  automatic_reset_after_ms: null,
};

export interface ActorMessageRateLimiterOptions {
  /**
   * Injectable clock for tests. ms since epoch. Defaults to Date.now.
   */
  readonly now?: () => number;
  /**
   * If set, the limiter caches policy-atom reads for this many ms
   * before re-querying. Defaults to 10_000 (10s). Zero disables
   * caching (re-reads on every checkWrite; slow, used in tests).
   */
  readonly policyCacheMs?: number;
}

export class ActorMessageRateLimiter {
  private readonly host: Host;
  private readonly now: () => number;
  private readonly policyCacheMs: number;

  /** Per-principal token bucket state. */
  private readonly buckets = new Map<string, BucketState>();
  /** Per-principal rolling list of denial timestamps (ms). */
  private readonly denials = new Map<string, number[]>();

  /** Cached policy values + expiry. */
  private cachedDefaultRate: RateConfig = FALLBACK_RATE;
  private cachedPerPrincipalRate = new Map<string, RateConfig>();
  private cachedCircuit: CircuitConfig = FALLBACK_CIRCUIT;
  private cacheExpiresAt = 0;

  constructor(host: Host, options: ActorMessageRateLimiterOptions = {}) {
    this.host = host;
    this.now = options.now ?? (() => Date.now());
    this.policyCacheMs = options.policyCacheMs ?? 10_000;
  }

  /**
   * Gate a prospective write. Throws RateLimitedError or
   * CircuitBreakerOpenError on denial; returns void on pass (caller
   * proceeds with host.atoms.put).
   */
  async checkWrite(principalId: PrincipalId): Promise<void> {
    await this.refreshPolicyIfStale();

    // Circuit-breaker gate first: if the principal is tripped, the
    // bucket state is irrelevant; the write must not consume a token
    // from a principal that is currently locked out.
    const openTripId = await this.openTripFor(principalId);
    if (openTripId !== null) {
      throw new CircuitBreakerOpenError(principalId, openTripId);
    }

    const rate = this.effectiveRateFor(principalId);
    const nowMs = this.now();
    const bucket = this.bucketFor(principalId, rate, nowMs);

    if (bucket.tokens < 1) {
      // Denial. Record it; if threshold reached inside the window, trip.
      const denialTimes = this.denials.get(String(principalId)) ?? [];
      denialTimes.push(nowMs);
      // Drop timestamps outside the window so the list stays bounded.
      const cutoff = nowMs - this.cachedCircuit.window_ms;
      while (denialTimes.length > 0 && denialTimes[0]! < cutoff) denialTimes.shift();
      this.denials.set(String(principalId), denialTimes);

      if (denialTimes.length >= this.cachedCircuit.denial_count_trip_threshold) {
        const tripAtomId = await this.writeTripAtom(principalId, denialTimes.length);
        // After trip, clear denial history so the next unrelated burst
        // starts fresh after the reset is cleared.
        this.denials.delete(String(principalId));
        throw new CircuitBreakerOpenError(principalId, tripAtomId);
      }

      throw new RateLimitedError(principalId, rate.tokens_per_minute);
    }

    bucket.tokens -= 1;
  }

  /**
   * Re-read policy atoms from the AtomStore if the cache is stale.
   * Safe to call on every checkWrite; the cache keeps it cheap.
   */
  private async refreshPolicyIfStale(): Promise<void> {
    const nowMs = this.now();
    if (this.policyCacheMs > 0 && nowMs < this.cacheExpiresAt) return;

    const rateAtoms = await this.queryPolicyAtoms('actor-message-rate');
    const defaultRate = rateAtoms.find((a) => policyPrincipal(a) === '*');
    const perPrincipal = rateAtoms.filter((a) => {
      const p = policyPrincipal(a);
      return p !== '*' && p !== undefined;
    });

    this.cachedDefaultRate = defaultRate ? readRateConfig(defaultRate) : FALLBACK_RATE;
    this.cachedPerPrincipalRate = new Map(
      perPrincipal.map((a) => [policyPrincipal(a) as string, readRateConfig(a)]),
    );

    const circuitAtoms = await this.queryPolicyAtoms('actor-message-circuit-breaker');
    this.cachedCircuit = circuitAtoms.length > 0
      ? readCircuitConfig(circuitAtoms[0]!)
      : FALLBACK_CIRCUIT;

    this.cacheExpiresAt = this.policyCacheMs > 0 ? nowMs + this.policyCacheMs : 0;
  }

  /**
   * Query policy atoms for a given subject. Directives only (L3).
   * Excludes tainted and superseded atoms defensively so a compromised
   * atom cannot silently widen rate limits or relax the trip
   * threshold.
   */
  private async queryPolicyAtoms(subject: string): Promise<Atom[]> {
    const filter: AtomFilter = { type: ['directive'], layer: ['L3'] };
    const page = await this.host.atoms.query(filter, 200);
    return page.atoms.filter((a) => {
      if (a.taint !== 'clean') return false;
      if (a.superseded_by.length > 0) return false;
      const policy = (a.metadata as Record<string, unknown>)?.policy as
        | Record<string, unknown>
        | undefined;
      return policy?.subject === subject;
    });
  }

  /**
   * Resolve the effective rate for a principal. Per-principal override
   * beats the `principal: '*'` default.
   */
  private effectiveRateFor(principalId: PrincipalId): RateConfig {
    const specific = this.cachedPerPrincipalRate.get(String(principalId));
    return specific ?? this.cachedDefaultRate;
  }

  /**
   * Look up or initialize the bucket for a principal, refilling tokens
   * proportional to elapsed time.
   */
  private bucketFor(
    principalId: PrincipalId,
    rate: RateConfig,
    nowMs: number,
  ): BucketState {
    const key = String(principalId);
    const existing = this.buckets.get(key);
    if (existing === undefined) {
      const fresh: BucketState = {
        tokens: rate.burst_capacity,
        last_refill_ms: nowMs,
      };
      this.buckets.set(key, fresh);
      return fresh;
    }
    // Refill: tokens per ms = tokens_per_minute / 60_000.
    const elapsedMs = Math.max(0, nowMs - existing.last_refill_ms);
    const refill = (elapsedMs * rate.tokens_per_minute) / 60_000;
    existing.tokens = Math.min(rate.burst_capacity, existing.tokens + refill);
    existing.last_refill_ms = nowMs;
    return existing;
  }

  /**
   * Scan for an unresolved `circuit-breaker-trip` for the given
   * principal. A trip is unresolved if (a) it has not been superseded
   * by a reset atom and (b) it has not self-cleared via
   * automatic_reset_after_ms.
   *
   * Returns the trip atom id if open, null otherwise.
   */
  private async openTripFor(principalId: PrincipalId): Promise<string | null> {
    const filter: AtomFilter = { type: ['circuit-breaker-trip'] };
    const page = await this.host.atoms.query(filter, 200);
    const candidateTrips = page.atoms.filter((a) => {
      if (a.superseded_by.length > 0) return false;
      const envelope = (a.metadata as Record<string, unknown>)?.trip as
        | { target_principal?: string }
        | undefined;
      return envelope?.target_principal === String(principalId);
    });
    if (candidateTrips.length === 0) return null;

    // If auto-reset is configured, drop trips older than the interval.
    const autoReset = this.cachedCircuit.automatic_reset_after_ms;
    if (autoReset !== null) {
      const nowMs = this.now();
      const liveTrips = candidateTrips.filter((a) => {
        const createdMs = Date.parse(a.created_at);
        return Number.isFinite(createdMs) && (nowMs - createdMs) < autoReset;
      });
      if (liveTrips.length === 0) return null;
      return String(liveTrips[0]!.id);
    }

    return String(candidateTrips[0]!.id);
  }

  /**
   * Write a trip atom. Returns the atom id.
   */
  private async writeTripAtom(
    principalId: PrincipalId,
    denialCount: number,
  ): Promise<string> {
    const nowIso = new Date(this.now()).toISOString() as Time;
    const tripId = `cbt-${String(principalId)}-${this.now()}` as const;
    const atom: Atom = {
      schema_version: 1,
      id: tripId as unknown as Atom['id'],
      content: `circuit-breaker trip for ${String(principalId)}: `
        + `${denialCount} denials in ${this.cachedCircuit.window_ms}ms window`,
      type: 'circuit-breaker-trip',
      layer: 'L1',
      provenance: {
        kind: 'agent-observed',
        source: { tool: 'actor-message-rate-limiter', agent_id: 'rate-limiter' },
        derived_from: [],
      },
      confidence: 1.0,
      created_at: nowIso,
      last_reinforced_at: nowIso,
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
      // The limiter itself is the writer; using a well-known principal
      // keeps trips distinguishable from atoms authored by arbitrary
      // agents. Deployments that want a specific principal override
      // this via wiring.
      principal_id: 'rate-limiter' as unknown as Atom['principal_id'],
      taint: 'clean',
      metadata: {
        trip: {
          target_principal: String(principalId),
          reason: `${denialCount} denials in ${this.cachedCircuit.window_ms}ms window`,
          denial_count: denialCount,
          window_ms: this.cachedCircuit.window_ms,
          tripped_at: nowIso,
        },
      },
    };
    await this.host.atoms.put(atom);
    return tripId;
  }
}

/** Read the per-principal tag from a policy atom. */
function policyPrincipal(atom: Atom): string | undefined {
  const policy = (atom.metadata as Record<string, unknown>)?.policy as
    | Record<string, unknown>
    | undefined;
  return policy?.principal as string | undefined;
}

function readRateConfig(atom: Atom): RateConfig {
  const policy = (atom.metadata as Record<string, unknown>)?.policy as
    | Record<string, unknown>
    | undefined;
  const tpm = Number(policy?.tokens_per_minute);
  const burst = Number(policy?.burst_capacity);
  if (!Number.isFinite(tpm) || tpm <= 0 || !Number.isFinite(burst) || burst <= 0) {
    return FALLBACK_RATE;
  }
  return { tokens_per_minute: tpm, burst_capacity: burst };
}

function readCircuitConfig(atom: Atom): CircuitConfig {
  const policy = (atom.metadata as Record<string, unknown>)?.policy as
    | Record<string, unknown>
    | undefined;
  const threshold = Number(policy?.denial_count_trip_threshold);
  const window = Number(policy?.window_ms);
  const autoRaw = policy?.automatic_reset_after_ms;
  const auto = autoRaw === null || autoRaw === undefined
    ? null
    : Number.isFinite(Number(autoRaw)) && Number(autoRaw) > 0
      ? Number(autoRaw)
      : null;
  if (!Number.isFinite(threshold) || threshold < 1 || !Number.isFinite(window) || window <= 0) {
    return FALLBACK_CIRCUIT;
  }
  return {
    denial_count_trip_threshold: threshold,
    window_ms: window,
    automatic_reset_after_ms: auto,
  };
}
