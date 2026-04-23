/**
 * Intervention scanner tests.
 *
 * Scans a Claude Code JSONL session log for operator course-corrections
 * - user turns following a tool_use that contain rejection/correction
 * keywords. Becomes the raw input for the Friday canon-proposal ritual.
 *
 * Tests:
 *   - Detects "no, actually ...", "don't forget ...", and "wrong -" as
 *     course-corrections on the synthetic fixture.
 *   - Ignores "thanks", "ok", and initial task prompts (no preceding
 *     tool_use).
 *   - Returns structured records with prompt, timestamp, sessionId.
 *   - Works on a file path directly (no dir scan needed).
 */
import { describe, expect, it } from 'vitest';

import { scanJsonl } from '../../scripts/scan-interventions.mjs';

const FIXTURE = 'test/fixtures/synthetic-session.jsonl';

describe('scanJsonl', () => {
  it('detects 3 course-corrections in the synthetic fixture', async () => {
    const results = await scanJsonl(FIXTURE);
    expect(results.length).toBe(3);
  });

  it('each result carries prompt, timestamp, sessionId, type', async () => {
    const results = await scanJsonl(FIXTURE);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.type).toBe('course-correction');
      expect(typeof r.prompt).toBe('string');
      expect(r.prompt.length).toBeGreaterThan(0);
      expect(typeof r.timestamp).toBe('string');
      expect(r.session).toBe('sess-001');
    }
  });

  it('detects "no, actually ..." correction', async () => {
    const results = await scanJsonl(FIXTURE);
    expect(
      results.some((r) => /no, actually/i.test(r.prompt)),
    ).toBe(true);
  });

  it('detects "don\'t forget" correction', async () => {
    const results = await scanJsonl(FIXTURE);
    expect(
      results.some((r) => /don'?t forget/i.test(r.prompt)),
    ).toBe(true);
  });

  it('detects "wrong" correction', async () => {
    const results = await scanJsonl(FIXTURE);
    expect(
      results.some((r) => /\bwrong\b/i.test(r.prompt)),
    ).toBe(true);
  });

  it('ignores "looks good, thanks" and "ok" acknowledgments', async () => {
    const results = await scanJsonl(FIXTURE);
    expect(results.every((r) => !/looks good, thanks/.test(r.prompt))).toBe(true);
    expect(results.every((r) => r.prompt.trim() !== 'ok')).toBe(true);
  });

  it('ignores the initial user prompt (no prior tool_use)', async () => {
    const results = await scanJsonl(FIXTURE);
    // First message never preceded by tool_use, so it must not surface.
    expect(
      results.every(
        (r) => r.prompt !== 'add a scan-interventions script that finds course-corrections',
      ),
    ).toBe(true);
  });

  it('returns [] on an empty file', async () => {
    // Use the fixture's parent dir + a non-existent name would throw;
    // instead validate with a fresh empty temp file.
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'lag-scan-'));
    const empty = join(dir, 'empty.jsonl');
    await writeFile(empty, '');
    try {
      const results = await scanJsonl(empty);
      expect(results).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
