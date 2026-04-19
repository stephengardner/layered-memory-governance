import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  DETECT_SCHEMA,
  DETECT_SYSTEM,
  detectConflict,
} from '../../src/arbitration/detect.js';
import { sampleAtom } from '../fixtures.js';

describe('detectConflict', () => {
  it('content-hash shortcut returns none for identical content', async () => {
    const host = createMemoryHost();
    const a = sampleAtom({ content: 'Use Postgres.' });
    const b = sampleAtom({ content: 'use postgres' }); // content-hash normalized equal
    const pair = await detectConflict(a, b, host);
    expect(pair.kind).toBe('none');
    expect(pair.explanation).toContain('content hashes match');
  });

  it('delegates to LLM when content differs', async () => {
    const host = createMemoryHost();
    const a = sampleAtom({ content: 'We use Postgres for the main database.' });
    const b = sampleAtom({ content: 'We use MySQL for the main database.' });

    host.llm.register(
      DETECT_SCHEMA,
      DETECT_SYSTEM,
      {
        atom_a: {
          content: a.content,
          type: a.type,
          layer: a.layer,
          created_at: a.created_at,
        },
        atom_b: {
          content: b.content,
          type: b.type,
          layer: b.layer,
          created_at: b.created_at,
        },
      },
      { kind: 'semantic', explanation: 'Contradictory DB claims for the same service.' },
    );

    const pair = await detectConflict(a, b, host);
    expect(pair.kind).toBe('semantic');
    expect(pair.explanation).toContain('Contradictory');
  });

  it('passes through a "temporal" classification', async () => {
    const host = createMemoryHost();
    const a = sampleAtom({ content: 'In 2020 we used Redux.' });
    const b = sampleAtom({ content: 'Since 2024 we use Zustand.' });
    host.llm.register(
      DETECT_SCHEMA,
      DETECT_SYSTEM,
      {
        atom_a: { content: a.content, type: a.type, layer: a.layer, created_at: a.created_at },
        atom_b: { content: b.content, type: b.type, layer: b.layer, created_at: b.created_at },
      },
      { kind: 'temporal', explanation: 'Different time periods, both true.' },
    );
    const pair = await detectConflict(a, b, host);
    expect(pair.kind).toBe('temporal');
  });
});
