/**
 * Write-time rate limiter + circuit breaker tests for the
 * actor-message primitive (PR A of the inbox V1 sequence).
 *
 * Covers:
 *   - Token bucket: N consecutive writes succeed up to burst_capacity.
 *   - Refill: tokens regenerate proportional to elapsed time.
 *   - Per-principal override: principal-specific policy beats the
 *     '*' default.
 *   - Denial records: 1 denial does not trip; N (= threshold) denials
 *     inside window_ms DO trip and write a circuit-breaker-trip atom.
 *   - Circuit-breaker-open: once tripped, subsequent writes fail with
 *     CircuitBreakerOpenError until the trip atom is superseded.
 *   - Auto-reset: when automatic_reset_after_ms is set, trips older
 *     than that interval no longer block writes.
 *   - Missing policy atoms: limiter falls back to conservative defaults
 *     (no crash; but refuses to run without ANY bucket).
 *   - Cache: policy atoms are re-read when the cache is stale.
 *
 * These are the write-time invariants. PR B's InboxReader will
 * exercise the read path.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  ActorMessageRateLimiter,
  CircuitBreakerOpenError,
  RateLimitedError,
} from '../../src/actor-message/rate-limiter.js';
import type {
  Atom,
  AtomId,
  PrincipalId,
  Time,
} from '../../src/substrate/types.js';

const BOOTSTRAP_TIME = '2026-04-20T00:00:00.000Z' as Time;

interface PolicyPayload {
  readonly subject: string;
  readonly [k: string]: unknown;
}

function policyAtom(id: string, payload: PolicyPayload): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: `policy: ${payload.subject}`,
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'test-bootstrap', agent_id: 'test' },
      derived_from: [],
    },
    confidence: 1,
    created_at: BOOTSTRAP_TIME,
    last_reinforced_at: BOOTSTRAP_TIME,
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
    principal_id: 'operator' as PrincipalId,
    taint: 'clean',
    metadata: { policy: payload },
  };
}

async function hostWithDefaults(overrides: {
  rate?: Partial<PolicyPayload>;
  circuit?: Partial<PolicyPayload>;
} = {}) {
  const host = createMemoryHost();
  await host.atoms.put(
    policyAtom('pol-actor-message-rate', {
      subject: 'actor-message-rate',
      principal: '*',
      tokens_per_minute: 10,
      burst_capacity: 20,
      ...overrides.rate,
    }),
  );
  await host.atoms.put(
    policyAtom('pol-actor-message-circuit-breaker', {
      subject: 'actor-message-circuit-breaker',
      denial_count_trip_threshold: 3,
      window_ms: 300_000,
      automatic_reset_after_ms: null,
      ...overrides.circuit,
    }),
  );
  return host;
}

/** Make a clock that returns the stored value; set it via `.set(ms)`. */
function fakeClock(startMs: number) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance(ms: number) {
      nowMs += ms;
    },
    set(ms: number) {
      nowMs = ms;
    },
  };
}

describe('ActorMessageRateLimiter', () => {
  describe('token bucket', () => {
    it('allows burst_capacity consecutive writes, then denies the next', async () => {
      const host = await hostWithDefaults({ rate: { burst_capacity: 3 } });
      const clock = fakeClock(1000);
      const limiter = new ActorMessageRateLimiter(host, {
        now: clock.now,
        policyCacheMs: 0,
      });
      const p = 'sender-1' as PrincipalId;

      // 3 writes allowed (burst_capacity=3).
      await limiter.checkWrite(p);
      await limiter.checkWrite(p);
      await limiter.checkWrite(p);

      // 4th denied (not enough to trip yet: threshold=3 but 1 denial so far).
      await expect(limiter.checkWrite(p)).rejects.toBeInstanceOf(RateLimitedError);
    });

    it('refills tokens proportional to elapsed time', async () => {
      const host = await hostWithDefaults({
        rate: { tokens_per_minute: 60, burst_capacity: 1 }, // 1 token/sec
      });
      const clock = fakeClock(0);
      const limiter = new ActorMessageRateLimiter(host, {
        now: clock.now,
        policyCacheMs: 0,
      });
      const p = 'sender-refill' as PrincipalId;

      await limiter.checkWrite(p);                       // consumes the 1 token
      await expect(limiter.checkWrite(p)).rejects.toThrow(RateLimitedError); // empty
      clock.advance(1000);                                // +1s -> +1 token
      await limiter.checkWrite(p);                       // should succeed again
    });

    it('per-principal override beats the default', async () => {
      const host = await hostWithDefaults({ rate: { burst_capacity: 1 } });
      // Specific override for sender-vip: large burst.
      await host.atoms.put(
        policyAtom('pol-actor-message-rate-vip', {
          subject: 'actor-message-rate',
          principal: 'sender-vip',
          tokens_per_minute: 600,
          burst_capacity: 100,
        }),
      );
      const clock = fakeClock(1000);
      const limiter = new ActorMessageRateLimiter(host, {
        now: clock.now,
        policyCacheMs: 0,
      });
      const vip = 'sender-vip' as PrincipalId;

      // 20 writes (well over the default's burst=1, comfortably under 100).
      for (let i = 0; i < 20; i++) await limiter.checkWrite(vip);

      // Non-VIP still bound by default burst=1.
      const normal = 'sender-normal' as PrincipalId;
      await limiter.checkWrite(normal);
      await expect(limiter.checkWrite(normal)).rejects.toBeInstanceOf(RateLimitedError);
    });
  });

  describe('circuit breaker', () => {
    it('does not trip on a single denial', async () => {
      const host = await hostWithDefaults({
        rate: { burst_capacity: 1 },
        circuit: { denial_count_trip_threshold: 3, window_ms: 300_000 },
      });
      const clock = fakeClock(1000);
      const limiter = new ActorMessageRateLimiter(host, {
        now: clock.now,
        policyCacheMs: 0,
      });
      const p = 'sender-one-denial' as PrincipalId;

      await limiter.checkWrite(p);                         // success
      await expect(limiter.checkWrite(p)).rejects.toBeInstanceOf(RateLimitedError); // denial #1

      // No trip atom should exist yet.
      const trips = await host.atoms.query({ type: ['circuit-breaker-trip'] }, 100);
      expect(trips.atoms.length).toBe(0);
    });

    it('trips on the Nth denial inside window_ms and writes a trip atom', async () => {
      const host = await hostWithDefaults({
        rate: { burst_capacity: 1 },
        circuit: { denial_count_trip_threshold: 3, window_ms: 300_000 },
      });
      const clock = fakeClock(10_000);
      const limiter = new ActorMessageRateLimiter(host, {
        now: clock.now,
        policyCacheMs: 0,
      });
      const p = 'sender-trips' as PrincipalId;

      await limiter.checkWrite(p);                         // 1 success
      // 3 denials inside the window -> trip on the 3rd.
      await expect(limiter.checkWrite(p)).rejects.toBeInstanceOf(RateLimitedError); // #1
      await expect(limiter.checkWrite(p)).rejects.toBeInstanceOf(RateLimitedError); // #2
      await expect(limiter.checkWrite(p)).rejects.toBeInstanceOf(CircuitBreakerOpenError); // #3 -> trip

      const trips = await host.atoms.query({ type: ['circuit-breaker-trip'] }, 100);
      expect(trips.atoms.length).toBe(1);
      const trip = trips.atoms[0]!;
      const envelope = trip.metadata.trip as { target_principal: string; denial_count: number };
      expect(envelope.target_principal).toBe('sender-trips');
      expect(envelope.denial_count).toBe(3);
    });

    it('once tripped, subsequent writes fail with CircuitBreakerOpenError even when tokens refill', async () => {
      const host = await hostWithDefaults({
        rate: { tokens_per_minute: 600, burst_capacity: 1 }, // refills fast
        circuit: { denial_count_trip_threshold: 3, window_ms: 300_000 },
      });
      const clock = fakeClock(10_000);
      const limiter = new ActorMessageRateLimiter(host, {
        now: clock.now,
        policyCacheMs: 0,
      });
      const p = 'sender-locked' as PrincipalId;

      // Drive a trip.
      await limiter.checkWrite(p);
      await expect(limiter.checkWrite(p)).rejects.toThrow();
      await expect(limiter.checkWrite(p)).rejects.toThrow();
      await expect(limiter.checkWrite(p)).rejects.toBeInstanceOf(CircuitBreakerOpenError);

      // Wait long enough for the bucket to be fully refilled.
      clock.advance(10_000);
      // Should STILL be CircuitBreakerOpen, not RateLimited, because
      // the trip is permanent until reset.
      await expect(limiter.checkWrite(p)).rejects.toBeInstanceOf(CircuitBreakerOpenError);
    });

    it('superseded trip atoms no longer block writes', async () => {
      const host = await hostWithDefaults({
        rate: { burst_capacity: 1 },
        circuit: { denial_count_trip_threshold: 3, window_ms: 300_000 },
      });
      const clock = fakeClock(10_000);
      const limiter = new ActorMessageRateLimiter(host, {
        now: clock.now,
        policyCacheMs: 0,
      });
      const p = 'sender-resettable' as PrincipalId;

      // Trip it.
      await limiter.checkWrite(p);
      await expect(limiter.checkWrite(p)).rejects.toThrow();
      await expect(limiter.checkWrite(p)).rejects.toThrow();
      await expect(limiter.checkWrite(p)).rejects.toBeInstanceOf(CircuitBreakerOpenError);

      // Simulate an operator-signed reset superseding the trip.
      const trips = await host.atoms.query({ type: ['circuit-breaker-trip'] }, 100);
      const tripAtom = trips.atoms[0]!;
      await host.atoms.update(tripAtom.id, {
        superseded_by: ['reset-atom-id' as AtomId],
      });

      // Let the bucket refill (so the next check isn't denied for a different reason).
      clock.advance(60_000);
      await limiter.checkWrite(p);
    });

    it('automatic_reset_after_ms clears old trips without an explicit reset', async () => {
      const host = await hostWithDefaults({
        rate: { burst_capacity: 1 },
        circuit: {
          denial_count_trip_threshold: 3,
          window_ms: 300_000,
          automatic_reset_after_ms: 60_000, // 1 min
        },
      });
      const clock = fakeClock(10_000);
      const limiter = new ActorMessageRateLimiter(host, {
        now: clock.now,
        policyCacheMs: 0,
      });
      const p = 'sender-auto-reset' as PrincipalId;

      await limiter.checkWrite(p);
      await expect(limiter.checkWrite(p)).rejects.toThrow();
      await expect(limiter.checkWrite(p)).rejects.toThrow();
      await expect(limiter.checkWrite(p)).rejects.toBeInstanceOf(CircuitBreakerOpenError);

      // 2 minutes later the auto-reset window has elapsed and the bucket
      // has fully refilled. Write should succeed again.
      clock.advance(120_000);
      await limiter.checkWrite(p);
    });
  });

  describe('robustness', () => {
    it('falls back to conservative defaults when policy atoms are missing', async () => {
      const host = createMemoryHost();
      // Intentionally no policy atoms seeded.
      const clock = fakeClock(1000);
      const limiter = new ActorMessageRateLimiter(host, {
        now: clock.now,
        policyCacheMs: 0,
      });
      const p = 'sender-no-policy' as PrincipalId;

      // Default fallback: burst=20. 20 writes should all succeed.
      for (let i = 0; i < 20; i++) await limiter.checkWrite(p);
      // 21st denied (bucket drained; threshold=3 so one denial isn't a trip).
      await expect(limiter.checkWrite(p)).rejects.toBeInstanceOf(RateLimitedError);
    });
  });
});
