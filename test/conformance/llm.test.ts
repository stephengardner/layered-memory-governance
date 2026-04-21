import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { UnsupportedError, ValidationError } from '../../src/substrate/errors.js';

const SCHEMA = { type: 'object', properties: { answer: { type: 'string' } } };

describe('LLM conformance (memory)', () => {
  it('registered response returns expected output', async () => {
    const host = createMemoryHost();
    host.llm.register(SCHEMA, 'system', { question: 'x' }, { answer: 'y' });
    const result = await host.llm.judge<{ answer: string }>(
      SCHEMA, 'system', { question: 'x' },
      { model: 'test-model', max_budget_usd: 0.01 },
    );
    expect(result.output.answer).toBe('y');
  });

  it('unregistered key throws UnsupportedError', async () => {
    const host = createMemoryHost();
    await expect(
      host.llm.judge(SCHEMA, 'system', { question: 'unseen' },
        { model: 'test-model', max_budget_usd: 0.01 }),
    ).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('metadata.prompt_fingerprint is sha256 of system', async () => {
    const host = createMemoryHost();
    const system = 'you are a judge';
    host.llm.register(SCHEMA, system, {}, { answer: 'ok' });
    const result = await host.llm.judge(
      SCHEMA, system, {},
      { model: 'test-model', max_budget_usd: 0.01 },
    );
    const expected = createHash('sha256').update(system, 'utf8').digest('hex');
    expect(result.metadata.prompt_fingerprint).toBe(expected);
  });

  it('metadata.model_used reflects options.model', async () => {
    const host = createMemoryHost();
    host.llm.register(SCHEMA, 's', {}, { answer: 'ok' });
    const result = await host.llm.judge(SCHEMA, 's', {}, { model: 'claude-haiku-4-5', max_budget_usd: 0.01 });
    expect(result.metadata.model_used).toBe('claude-haiku-4-5');
  });

  it('invalidateNext makes next judge throw ValidationError', async () => {
    const host = createMemoryHost();
    host.llm.register(SCHEMA, 's', {}, { answer: 'ok' });
    host.llm.invalidateNext();
    await expect(
      host.llm.judge(SCHEMA, 's', {}, { model: 'test-model', max_budget_usd: 0.01 }),
    ).rejects.toBeInstanceOf(ValidationError);
    // Subsequent call should work again (one-shot).
    const result = await host.llm.judge(SCHEMA, 's', {}, { model: 'test-model', max_budget_usd: 0.01 });
    expect(result.output).toEqual({ answer: 'ok' });
  });

  it('same inputs produce stable fingerprints regardless of key order', async () => {
    const host = createMemoryHost();
    host.llm.register(SCHEMA, 's', { a: 1, b: 2 }, { answer: 'ok' });
    const r = await host.llm.judge(
      SCHEMA, 's', { b: 2, a: 1 },
      { model: 'test-model', max_budget_usd: 0.01 },
    );
    expect(r.output).toEqual({ answer: 'ok' });
  });
});
