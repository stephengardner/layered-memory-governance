/**
 * Ambient governance tests (Phase 47).
 *
 * Verifies the daemon's ambientLoopTick and ambientExtractionTick run
 * the promotion engine and claim extractor against the host state.
 * Uses MemoryLLM with registered judge responses so extraction is
 * deterministic. Drives ticks explicitly rather than via intervals.
 */

import { describe, expect, it } from 'vitest';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { Daemon } from '../../src/runtime/daemon/index.js';
import { EXTRACT_CLAIMS } from '../../src/llm-judge/index.js';
import type { AtomId, PrincipalId, Time } from '../../src/substrate/types.js';
import { sampleAtom } from '../fixtures.js';

const PRINCIPAL = 'stephen-human' as PrincipalId;

async function emptyCanonPath() {
  const d = await mkdtemp(join(tmpdir(), 'lag-ambient-'));
  const p = join(d, 'CLAUDE.md');
  await writeFile(p, '');
  return p;
}

function noopFetch(): typeof fetch {
  return async () =>
    new Response(JSON.stringify({ ok: true, result: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

describe('Daemon.ambientExtractionTick', () => {
  it('runs extraction over L0 atoms and writes L1', async () => {
    const canonPath = await emptyCanonPath();
    const host = createMemoryHost();

    const l0 = sampleAtom({
      id: 'l0-amb' as AtomId,
      content: 'Stephen said: use Postgres',
      layer: 'L0',
      created_at: '2026-04-19T00:00:00.000Z' as Time,
      last_reinforced_at: '2026-04-19T00:00:00.000Z' as Time,
    });
    await host.atoms.put(l0);

    host.llm.register(
      EXTRACT_CLAIMS.jsonSchema,
      EXTRACT_CLAIMS.systemPrompt,
      { content: l0.content, type: l0.type, layer: l0.layer },
      { claims: [{ type: 'decision', content: 'Use Postgres.', confidence: 0.9 }] },
    );

    const daemon = new Daemon({
      host,
      botToken: 'FAKE',
      chatId: 1,
      canonFilePath: canonPath,
      principalResolver: () => PRINCIPAL,
      fetchImpl: noopFetch(),
      invokeImpl: (async () => ({ text: '', costUsd: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 })) as never,
    });

    await daemon.ambientExtractionTick();

    const l1 = await host.atoms.query({ layer: ['L1'] }, 10);
    expect(l1.atoms).toHaveLength(1);
    expect(l1.atoms[0]!.provenance.derived_from).toContain(l0.id);
  });
});

describe('Daemon.ambientLoopTick', () => {
  it('runs LoopRunner tick without throwing against an empty store', async () => {
    const canonPath = await emptyCanonPath();
    const host = createMemoryHost();
    const daemon = new Daemon({
      host,
      botToken: 'FAKE',
      chatId: 1,
      canonFilePath: canonPath,
      principalResolver: () => PRINCIPAL,
      fetchImpl: noopFetch(),
      invokeImpl: (async () => ({ text: '', costUsd: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 })) as never,
    });

    await expect(daemon.ambientLoopTick()).resolves.not.toThrow();
  });
});
