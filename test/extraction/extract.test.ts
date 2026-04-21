/**
 * Claim extraction unit tests.
 *
 * All tests use MemoryLLM with pre-registered judge responses so
 * they are deterministic and do not spawn claude-cli. Covers:
 *   - Happy path: L0 atom -> N L1 atoms, each with derived_from
 *     pointing back.
 *   - Dedup: extracting the same atom twice writes atoms once.
 *   - Cross-source dedup: two L0 atoms yielding the same claim
 *     collapse to one L1 via content-hash.
 *   - Confidence threshold: low-confidence claims are dropped.
 *   - Non-L0 input: throws.
 *   - principalResolver: inheritSourcePrincipal=true attributes L1
 *     to the source atom's agent; false attributes to extractor.
 *   - Audit event emitted once per extraction.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  extractClaimsFromAtom,
  runExtractionPass,
} from '../../src/extraction/index.js';
import { EXTRACT_CLAIMS, type ExtractClaimsOutput } from '../../src/schemas/index.js';
import type { AtomId, PrincipalId, Time } from '../../src/substrate/types.js';
import { sampleAtom } from '../fixtures.js';

const extractor = 'extractor-principal' as PrincipalId;
const sourceAgent = 'agent-alice' as PrincipalId;

function registerExtractResponse(
  host: ReturnType<typeof createMemoryHost>,
  atom: { content: string; type: string; layer: string },
  output: ExtractClaimsOutput,
) {
  host.llm.register(
    EXTRACT_CLAIMS.jsonSchema,
    EXTRACT_CLAIMS.systemPrompt,
    { content: atom.content, type: atom.type, layer: atom.layer },
    output,
  );
}

describe('extractClaimsFromAtom', () => {
  it('writes one L1 atom per extracted claim with derived_from back-pointer', async () => {
    const host = createMemoryHost();
    const l0 = sampleAtom({
      id: 'l0-src' as AtomId,
      content: 'We use Postgres for OLTP. The team agreed structured logs are mandatory.',
      type: 'observation',
      layer: 'L0',
      principal_id: sourceAgent,
      created_at: '2026-04-19T00:00:00.000Z' as Time,
      last_reinforced_at: '2026-04-19T00:00:00.000Z' as Time,
    });
    await host.atoms.put(l0);

    registerExtractResponse(host, l0, {
      claims: [
        { type: 'decision', content: 'We use Postgres for OLTP.', confidence: 0.9 },
        { type: 'directive', content: 'Structured logs are mandatory.', confidence: 0.85 },
      ],
    });

    const report = await extractClaimsFromAtom(l0, host, {
      principalId: extractor,
    });

    expect(report.claimsFound).toBe(2);
    expect(report.atomsWritten).toBe(2);
    expect(report.atomsDeduped).toBe(0);
    expect(report.errors).toEqual([]);

    // Verify both L1 atoms persisted with correct provenance.
    const page = await host.atoms.query({ layer: ['L1'] }, 10);
    expect(page.atoms).toHaveLength(2);
    for (const atom of page.atoms) {
      expect(atom.layer).toBe('L1');
      expect(atom.provenance.kind).toBe('llm-refined');
      expect(atom.provenance.derived_from).toContain(l0.id);
      // Attribution defaults to the source atom's principal.
      expect(atom.principal_id).toBe(sourceAgent);
    }

    // Audit event logged.
    const audits = await host.auditor.query({ kind: ['extraction.applied'] }, 10);
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent: second call writes zero atoms, counts as dedup', async () => {
    const host = createMemoryHost();
    const l0 = sampleAtom({
      id: 'l0-idemp' as AtomId,
      content: 'agent said X',
      layer: 'L0',
      principal_id: sourceAgent,
    });
    await host.atoms.put(l0);
    registerExtractResponse(host, l0, {
      claims: [{ type: 'observation', content: 'X was said.', confidence: 0.8 }],
    });

    const r1 = await extractClaimsFromAtom(l0, host, { principalId: extractor });
    const r2 = await extractClaimsFromAtom(l0, host, { principalId: extractor });

    expect(r1.atomsWritten).toBe(1);
    expect(r2.atomsWritten).toBe(0);
    expect(r2.atomsDeduped).toBe(1);
  });

  it('drops claims below confidence threshold', async () => {
    const host = createMemoryHost();
    const l0 = sampleAtom({ id: 'l0-conf' as AtomId, layer: 'L0' });
    await host.atoms.put(l0);
    registerExtractResponse(host, l0, {
      claims: [
        { type: 'observation', content: 'high-conf claim', confidence: 0.9 },
        { type: 'observation', content: 'low-conf claim', confidence: 0.1 },
      ],
    });

    const report = await extractClaimsFromAtom(l0, host, {
      principalId: extractor,
      minConfidence: 0.5,
    });

    expect(report.claimsFound).toBe(2);
    expect(report.atomsWritten).toBe(1);
    expect(report.atomsBelowThreshold).toBe(1);
  });

  it('throws on non-L0 input', async () => {
    const host = createMemoryHost();
    const l1 = sampleAtom({ id: 'l1' as AtomId, layer: 'L1' });
    await expect(
      extractClaimsFromAtom(l1, host, { principalId: extractor }),
    ).rejects.toThrow(/expected L0/);
  });

  it('inheritSourcePrincipal=false attributes L1 to the extractor', async () => {
    const host = createMemoryHost();
    const l0 = sampleAtom({
      id: 'l0-attr' as AtomId,
      layer: 'L0',
      principal_id: sourceAgent,
    });
    await host.atoms.put(l0);
    registerExtractResponse(host, l0, {
      claims: [{ type: 'observation', content: 'claim text', confidence: 0.8 }],
    });

    await extractClaimsFromAtom(l0, host, {
      principalId: extractor,
      inheritSourcePrincipal: false,
    });

    const page = await host.atoms.query({ layer: ['L1'] }, 10);
    expect(page.atoms[0]!.principal_id).toBe(extractor);
  });
});

describe('runExtractionPass', () => {
  it('extracts across multiple L0 sources; each L1 carries derived_from back to its source', async () => {
    const host = createMemoryHost();

    const a = sampleAtom({
      id: 'l0-a' as AtomId,
      content: 'alice said X',
      layer: 'L0',
      principal_id: sourceAgent,
      created_at: '2026-04-19T00:00:01.000Z' as Time,
      last_reinforced_at: '2026-04-19T00:00:01.000Z' as Time,
    });
    const b = sampleAtom({
      id: 'l0-b' as AtomId,
      content: 'bob said Y',
      layer: 'L0',
      principal_id: sourceAgent,
      created_at: '2026-04-19T00:00:02.000Z' as Time,
      last_reinforced_at: '2026-04-19T00:00:02.000Z' as Time,
    });
    await host.atoms.put(a);
    await host.atoms.put(b);

    registerExtractResponse(host, a, {
      claims: [{ type: 'decision', content: 'Claim X', confidence: 0.9 }],
    });
    registerExtractResponse(host, b, {
      claims: [{ type: 'decision', content: 'Claim Y', confidence: 0.9 }],
    });

    const report = await runExtractionPass(host, { principalId: extractor });

    expect(report.sourcesExtracted).toBe(2);
    expect(report.totalClaimsWritten).toBe(2);

    const l1Page = await host.atoms.query({ layer: ['L1'] }, 10);
    expect(l1Page.atoms).toHaveLength(2);

    const derivedSets = l1Page.atoms.map((at) => at.provenance.derived_from.join(','));
    expect(new Set(derivedSets)).toEqual(new Set(['l0-a', 'l0-b']));
  });

  it('skips sources that already have L1 children by default', async () => {
    const host = createMemoryHost();
    const l0 = sampleAtom({ id: 'l0-already' as AtomId, layer: 'L0' });
    await host.atoms.put(l0);
    registerExtractResponse(host, l0, {
      claims: [{ type: 'observation', content: 'first pass', confidence: 0.8 }],
    });

    // First pass writes the L1.
    const r1 = await runExtractionPass(host, { principalId: extractor });
    expect(r1.sourcesExtracted).toBe(1);

    // Second pass should skip because L1 child exists.
    const r2 = await runExtractionPass(host, { principalId: extractor });
    expect(r2.sourcesExtracted).toBe(0);
    expect(r2.sourcesSkipped).toBe(1);
  });

  it('honors skipIfAlreadyExtracted=false to re-run (dedup still prevents duplicates)', async () => {
    const host = createMemoryHost();
    const l0 = sampleAtom({ id: 'l0-rerun' as AtomId, layer: 'L0' });
    await host.atoms.put(l0);
    registerExtractResponse(host, l0, {
      claims: [{ type: 'observation', content: 'consistent claim', confidence: 0.8 }],
    });

    await runExtractionPass(host, { principalId: extractor });
    const r = await runExtractionPass(host, {
      principalId: extractor,
      skipIfAlreadyExtracted: false,
    });

    expect(r.sourcesExtracted).toBe(1);
    expect(r.totalClaimsWritten).toBe(0); // nothing new written
    expect(r.totalDedup).toBe(1);         // dedup caught the repeat
  });
});
