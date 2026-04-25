import { describe, it, expect } from 'vitest';
import type { AtomId } from '../../../src/substrate/types.js';
import { buildPromptText } from '../../../examples/agent-loops/claude-code/prompt-builder.js';

const PLAN_ID = 'plan-abc' as AtomId;

describe('buildPromptText', () => {
  it('returns just questionPrompt when no other fields present', () => {
    const out = buildPromptText({ planAtomId: PLAN_ID, questionPrompt: 'do X' });
    expect(out).toBe('do X');
  });

  it('appends file_contents block per entry', () => {
    const out = buildPromptText({
      planAtomId: PLAN_ID,
      questionPrompt: 'edit',
      fileContents: [{ path: 'src/a.ts', content: 'aaa' }, { path: 'src/b.ts', content: 'bbb' }],
    });
    expect(out).toContain('<file_contents path="src/a.ts">');
    expect(out).toContain('aaa');
    expect(out).toContain('</file_contents>');
    expect(out).toContain('<file_contents path="src/b.ts">');
    expect(out).toContain('bbb');
  });

  it('appends success_criteria block', () => {
    const out = buildPromptText({
      planAtomId: PLAN_ID,
      questionPrompt: 'do X',
      successCriteria: 'all tests pass',
    });
    expect(out).toContain('<success_criteria>all tests pass</success_criteria>');
  });

  it('appends target_paths block', () => {
    const out = buildPromptText({
      planAtomId: PLAN_ID,
      questionPrompt: 'do X',
      targetPaths: ['a.ts', 'b.ts'],
    });
    expect(out).toContain('<target_paths>a.ts, b.ts</target_paths>');
  });

  it('escapes a path containing special chars', () => {
    const out = buildPromptText({
      planAtomId: PLAN_ID,
      questionPrompt: 'do X',
      fileContents: [{ path: 'src/with"quote.ts', content: '...' }],
    });
    expect(out).toContain('<file_contents path="src/with&quot;quote.ts">');
  });

  it('returns empty string when no questionPrompt and no other fields', () => {
    const out = buildPromptText({ planAtomId: PLAN_ID });
    expect(out).toBe('');
  });

  it('omits empty fileContents array', () => {
    const out = buildPromptText({ planAtomId: PLAN_ID, questionPrompt: 'do X', fileContents: [] });
    expect(out).toBe('do X');
  });

  it('produces deterministic output for the same input', () => {
    const input = {
      planAtomId: PLAN_ID,
      questionPrompt: 'q',
      fileContents: [{ path: 'a.ts', content: 'A' }],
      successCriteria: 'sc',
      targetPaths: ['a.ts'],
    } as const;
    expect(buildPromptText(input)).toBe(buildPromptText(input));
  });
});
