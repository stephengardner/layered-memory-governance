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

  it('detects bare "no," correction (regex word-boundary regression, CR #105)', async () => {
    // CR finding PRRT_kwDOSGhm98588lGW: the previous `\b(no,|...)\b` form
    // fails because `\b` does not recognise a word->comma transition, so
    // a prompt starting with "no, write the test first" was silently
    // missed. Write a one-shot fixture exercising that exact shape.
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'lag-scan-no-'));
    const fixture = join(dir, 'no-fixture.jsonl');
    const lines = [
      {
        type: 'assistant',
        sessionId: 'sess-no',
        timestamp: '2026-04-21T00:00:00Z',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] },
      },
      {
        type: 'user',
        sessionId: 'sess-no',
        timestamp: '2026-04-21T00:00:01Z',
        message: { content: 'no, write the failing test first' },
      },
    ];
    await writeFile(fixture, lines.map((l) => JSON.stringify(l)).join('\n'));
    try {
      const results = await scanJsonl(fixture);
      expect(results.length).toBe(1);
      expect(results[0]!.prompt).toMatch(/^no,/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

  it('does NOT invoke main() when process.argv[1] is undefined (CR #105)', async () => {
    // CR finding PRRT_kwDOSGhm98588lGY: the guard at EOF used
    //   import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/') ?? '')
    // which evaluates to true whenever argv[1] is undefined, because
    // every string .endsWith(''). That causes main() to run on import.
    // This is the exact shape `node -e "await import(...)"` produces -
    // argv[1] is '-e' actually, but consumers who invoke via
    // `node --experimental-vm-modules -e` or spawn node inside harnesses
    // without a script path hit the same failure mode.
    //
    // The cross-platform guarded behaviour is: run main only when argv[1]
    // resolves to the scan-interventions.mjs file itself.
    //
    // We drive the failing shape by spawning node with `-e` that imports
    // the module. Under the buggy guard, main() runs and process exits 2
    // ("Usage: ..."). Under the fixed guard, the import returns cleanly.
    const { execSync } = await import('node:child_process');
    const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const workDir = mkdtempSync(join(tmpdir(), 'lag-import-guard-'));
    const scriptPath = new URL('../../scripts/scan-interventions.mjs', import.meta.url).href;
    try {
      const pendingDir = join(workDir, '.lag', 'pending-canon-proposals');
      let exited = 0;
      let stderr = '';
      try {
        // -e path keeps argv[1] pointed at "-e" or nothing the guard
        // recognises; the bug surfaces because the fallback ?? '' matches.
        execSync(`node -e "import('${scriptPath}').catch((e) => { process.exit(99); })"`, {
          cwd: workDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        const e = err as { status?: number; stderr?: Buffer };
        exited = Number(e.status ?? 1);
        stderr = e.stderr ? e.stderr.toString('utf8') : '';
      }
      // The buggy guard exits 2 via process.exit(2) in main() or runs
      // main -> statSync -> throws. The fixed guard exits 0.
      expect(exited, `stderr: ${stderr}`).toBe(0);
      expect(existsSync(pendingDir)).toBe(false);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
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
