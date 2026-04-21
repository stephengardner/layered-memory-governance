import { createHash } from 'node:crypto';
import { UnsupportedError, ValidationError } from '../../substrate/errors.js';
import type { LLM } from '../../substrate/interface.js';
import type {
  JsonSchema,
  JudgeMetadata,
  JudgeResult,
  LlmOptions,
} from '../../substrate/types.js';
import type { MemoryClock } from './clock.js';

/**
 * Deterministic mock LLM for tests and simulation.
 *
 * Pre-register responses by (system prompt, data fingerprint, schema fingerprint).
 * Unregistered calls throw UnsupportedError so tests never pass on stubs.
 *
 * A test-only `invalidateNext()` helper makes the next call throw
 * ValidationError, so the conformance suite can verify that real adapters
 * would surface schema-invalid output correctly.
 */
export class MemoryLLM implements LLM {
  private readonly responses = new Map<string, unknown>();
  private invalidOnce = false;

  constructor(private readonly clock: MemoryClock) {}

  async judge<T = unknown>(
    schema: JsonSchema,
    system: string,
    data: Readonly<Record<string, unknown>>,
    options: LlmOptions,
  ): Promise<JudgeResult<T>> {
    if (this.invalidOnce) {
      this.invalidOnce = false;
      throw new ValidationError('Mock LLM: output rejected by schema (simulated)');
    }
    const promptFp = sha256(system);
    const dataFp = sha256(stableStringify(data));
    const schemaFp = sha256(stableStringify(schema));
    const key = `${promptFp}|${dataFp}|${schemaFp}`;
    if (!this.responses.has(key)) {
      throw new UnsupportedError(
        `MemoryLLM has no registered response for key ${key}. ` +
        `Use register(schema, system, data, response) before calling judge.`,
      );
    }
    const response = this.responses.get(key) as T;
    const before = this.clock.monotonic();
    const after = this.clock.monotonic();
    const latencyTicks = Number(after - before);
    const metadata: JudgeMetadata = {
      model_used: options.model,
      input_tokens: -1,
      output_tokens: -1,
      cost_usd: -1,
      latency_ms: latencyTicks,
      prompt_fingerprint: promptFp,
      schema_fingerprint: schemaFp,
    };
    return { output: response, metadata };
  }

  // ---- Test helpers (NOT on LLM interface) ----

  /** Register a response keyed on (system, data, schema). */
  register(
    schema: JsonSchema,
    system: string,
    data: Readonly<Record<string, unknown>>,
    response: unknown,
  ): void {
    const promptFp = sha256(system);
    const dataFp = sha256(stableStringify(data));
    const schemaFp = sha256(stableStringify(schema));
    this.responses.set(`${promptFp}|${dataFp}|${schemaFp}`, response);
  }

  /** Next judge() call throws ValidationError. Useful for conformance tests. */
  invalidateNext(): void {
    this.invalidOnce = true;
  }

  registeredCount(): number {
    return this.responses.size;
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function stableStringify(x: unknown): string {
  if (x === null || typeof x !== 'object') return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(stableStringify).join(',')}]`;
  const entries = Object.entries(x as Record<string, unknown>).sort((a, b) => a[0].localeCompare(b[0]));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
