/**
 * Unit tests for the pre-push lint script.
 *
 * Each rule is tested by shelling out to the real script against a
 * temp directory containing fixture files that trigger or avoid the
 * rule. Running the script end-to-end covers argv parsing + file
 * walking + exit codes, not just the rule predicates in isolation.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', '..', 'scripts', 'pre-push-lint.mjs');

function runLint(cwd: string, args: ReadonlyArray<string> = []): { stdout: string; stderr: string; status: number } {
  // Always spawn the COPY under the temp tree so REPO_ROOT resolves
  // via import.meta.url to the temp dir, not the real repo root.
  const scriptInTree = join(cwd, 'scripts', 'pre-push-lint.mjs');
  const r = spawnSync('node', [scriptInTree, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PRE_PUSH_LINT_DEBUG: process.env.PRE_PUSH_LINT_DEBUG ?? '' },
  });
  return {
    stdout: (r.stdout ?? '').toString(),
    stderr: (r.stderr ?? '').toString(),
    status: typeof r.status === 'number' ? r.status : -1,
  };
}

describe('pre-push-lint', () => {
  let tree: string;

  beforeEach(() => {
    tree = mkdtempSync(join(tmpdir(), 'lag-lint-test-'));
    mkdirSync(join(tree, 'scripts'), { recursive: true });
    // Copy the real lint script into the temp tree so the test runs
    // the same binary against a fake repo-root.
    copyFileSync(SCRIPT, join(tree, 'scripts', 'pre-push-lint.mjs'));
  });

  afterEach(() => {
    try { rmSync(tree, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('exits 0 on an empty tree (only the lint script present)', () => {
    const r = runLint(tree);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('OK');
  });

  describe('rule: emdash', () => {
    it('flags an emdash in src/', () => {
      mkdirSync(join(tree, 'src'));
      writeFileSync(join(tree, 'src', 'a.ts'), "// prose with an \u2014 emdash\nexport const x = 1;\n");
      const r = runLint(tree, ['--rule=emdash']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[emdash]');
      expect(r.stderr).toContain('src/a.ts:1');
    });

    it('flags an en-dash (U+2013) alongside emdashes', () => {
      mkdirSync(join(tree, 'docs'));
      writeFileSync(join(tree, 'docs', 'note.md'), "A \u2013 en-dash here.\n");
      const r = runLint(tree, ['--rule=emdash']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('docs/note.md:1');
    });

    it('accepts plain hyphens', () => {
      mkdirSync(join(tree, 'src'));
      writeFileSync(join(tree, 'src', 'a.ts'), '// prose with a - hyphen\nexport const x = 1;\n');
      const r = runLint(tree, ['--rule=emdash']);
      expect(r.status).toBe(0);
    });
  });

  describe('rule: private-terms', () => {
    it('flags an operator-configured deny-list term', () => {
      writeFileSync(join(tree, 'README.md'), 'mentions ' + 'P' + 'hoenix here\n');
      const r = runLint(tree, ['--rule=private-terms']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[private-terms]');
      expect(r.stderr).toContain('README.md:1');
    });

    it('accepts unrelated terms', () => {
      writeFileSync(join(tree, 'README.md'), 'This has no deny-list terms.\n');
      const r = runLint(tree, ['--rule=private-terms']);
      expect(r.status).toBe(0);
    });
  });

  describe('rule: dogfooding-date-prefix', () => {
    it('flags a dogfooding md missing the YYYY-MM-DD prefix', () => {
      mkdirSync(join(tree, 'docs', 'dogfooding'), { recursive: true });
      writeFileSync(join(tree, 'docs', 'dogfooding', 'bad-name.md'), '# hi\n');
      const r = runLint(tree, ['--rule=dogfooding-date-prefix']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[dogfooding-date-prefix]');
      expect(r.stderr).toContain('bad-name.md');
    });

    it('accepts a correctly-dated dogfooding md', () => {
      mkdirSync(join(tree, 'docs', 'dogfooding'), { recursive: true });
      writeFileSync(join(tree, 'docs', 'dogfooding', '2026-04-23-ok.md'), '# hi\n');
      const r = runLint(tree, ['--rule=dogfooding-date-prefix']);
      expect(r.status).toBe(0);
    });

    it('accepts README.md without a date prefix (index doc)', () => {
      mkdirSync(join(tree, 'docs', 'dogfooding'), { recursive: true });
      writeFileSync(join(tree, 'docs', 'dogfooding', 'README.md'), '# index\n');
      const r = runLint(tree, ['--rule=dogfooding-date-prefix']);
      expect(r.status).toBe(0);
    });
  });

  describe('rule: z-utc-redundant', () => {
    it('flags `<Z> UTC` in docs/', () => {
      mkdirSync(join(tree, 'docs'));
      writeFileSync(
        join(tree, 'docs', 'retro.md'),
        '> Run: 2026-04-23T08:08:57Z UTC (partial)\n',
      );
      const r = runLint(tree, ['--rule=z-utc-redundant']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[z-utc-redundant]');
      expect(r.stderr).toContain('docs/retro.md:1');
    });

    it('accepts Z alone (ISO-8601)', () => {
      mkdirSync(join(tree, 'docs'));
      writeFileSync(
        join(tree, 'docs', 'retro.md'),
        '> Run: 2026-04-23T08:08:57Z (partial)\n',
      );
      const r = runLint(tree, ['--rule=z-utc-redundant']);
      expect(r.status).toBe(0);
    });
  });

  it('runs all rules by default and reports a combined count', () => {
    mkdirSync(join(tree, 'src'));
    writeFileSync(join(tree, 'src', 'a.ts'), 'x \u2014 y\n');
    mkdirSync(join(tree, 'docs', 'dogfooding'), { recursive: true });
    writeFileSync(join(tree, 'docs', 'dogfooding', 'no-prefix.md'), '# hi\n');
    const r = runLint(tree);
    expect(r.status).toBe(1);
    // Both rules' findings land in stderr.
    expect(r.stderr).toContain('[emdash]');
    expect(r.stderr).toContain('[dogfooding-date-prefix]');
    expect(r.stderr).toMatch(/FAIL \(\d+ findings\)/);
  });
});
