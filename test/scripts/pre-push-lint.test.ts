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

    // Regression: CI's package-hygiene step greps
    //   src/ test/ docs/ design/ README.md examples/
    // A pre-#122 version of this script dropped `test/` from the
    // scope, so an emdash under test/ would pass locally and then
    // fail CI -- exactly the ~10min-after-push gap the script exists
    // to close. CodeRabbit flagged the divergence on PR #122.
    it('flags an emdash under test/ (lint-vs-CI scope must match)', () => {
      mkdirSync(join(tree, 'test'));
      writeFileSync(join(tree, 'test', 't.test.ts'), "// a \u2014 emdash in a test file\n");
      const r = runLint(tree, ['--rule=emdash']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[emdash]');
      expect(r.stderr).toContain('test/t.test.ts:1');
    });

    // Emdash rule still skips `fixtures` directories -- CI's emdash
    // step uses `--exclude-dir=fixtures` because test fixtures
    // capture external output verbatim (e.g., CodeRabbit review
    // bodies the parser must handle). Rewriting emdashes in fixtures
    // would make format-drift tests lie.
    it('does NOT flag emdash inside a fixtures/ dir (mirrors CI --exclude-dir=fixtures)', () => {
      mkdirSync(join(tree, 'test', 'fixtures'), { recursive: true });
      writeFileSync(
        join(tree, 'test', 'fixtures', 'external.md'),
        'external content with an \u2014 emdash preserved verbatim\n',
      );
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

    // Regression: pre-#122 the script globally skipped `fixtures/`
    // for every rule, but CI's private-terms step scans tracked
    // files via `git ls-files | xargs grep` -- no fixtures
    // exclusion. A private term added under fixtures/ would pass
    // local lint and then fail CI. CodeRabbit flagged the divergence
    // on PR #122. The fix: scope the fixtures skip to the emdash
    // rule only.
    it('flags a deny-list term inside a fixtures/ dir (private-terms does NOT skip fixtures)', () => {
      mkdirSync(join(tree, 'test', 'fixtures'), { recursive: true });
      writeFileSync(
        join(tree, 'test', 'fixtures', 'legacy-body.md'),
        'a captured message mentioning ' + 'P' + 'hoenix verbatim\n',
      );
      const r = runLint(tree, ['--rule=private-terms']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[private-terms]');
      expect(r.stderr).toContain('test/fixtures/legacy-body.md:1');
    });

    // Regression: scripts/pre-push-lint.mjs contains the private-term
    // literals by construction (its regex reproduces the CI deny
    // list). It must self-exclude via PRIVATE_TERMS_SELF_EXCLUDE or
    // the script would fail its own rule on every run. The copy in
    // the temp tree already lives at scripts/pre-push-lint.mjs, so
    // invoking the rule on an otherwise empty tree is a direct test
    // of the self-exclusion path.
    it('does NOT flag the lint script itself (PRIVATE_TERMS_SELF_EXCLUDE is load-bearing)', () => {
      // No other files; only scripts/pre-push-lint.mjs from beforeEach.
      const r = runLint(tree, ['--rule=private-terms']);
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain('[private-terms]');
      expect(r.stdout).toContain('OK');
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

    // Regression: pre-second-pass the rule only walked the top level
    // of docs/dogfooding/, so a misnamed .md in a subdir (e.g., a
    // future per-quarter layout) would silently evade the
    // convention. The rule now recurses and flags nested files too.
    it('flags a misnamed md nested under docs/dogfooding/<subdir>/', () => {
      mkdirSync(join(tree, 'docs', 'dogfooding', '2026-q2'), { recursive: true });
      writeFileSync(
        join(tree, 'docs', 'dogfooding', '2026-q2', 'bad-name.md'),
        '# retro\n',
      );
      const r = runLint(tree, ['--rule=dogfooding-date-prefix']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[dogfooding-date-prefix]');
      expect(r.stderr).toContain('docs/dogfooding/2026-q2/bad-name.md');
    });

    it('accepts a correctly-dated nested dogfooding md', () => {
      mkdirSync(join(tree, 'docs', 'dogfooding', '2026-q2'), { recursive: true });
      writeFileSync(
        join(tree, 'docs', 'dogfooding', '2026-q2', '2026-04-23-nested-ok.md'),
        '# retro\n',
      );
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

  // Path-boundary anchor: walk() previously accepted any prefix
  // substring match, so `design` would match `designs-archive/`.
  // The fix requires either an exact match or a `/`-boundary after
  // the prefix. No defect today (no sibling dir exists), but the
  // rule is framework-level and needs to stay correct under any
  // future layout.
  describe('walk path-boundary semantics', () => {
    it('does NOT match a prefix that straddles a path boundary (design vs designs-archive)', () => {
      // Sibling directory with a name that *starts* with `design`
      // but isn't the `design/` directory. Put an emdash inside so
      // the rule WOULD flag if the boundary check is missing.
      mkdirSync(join(tree, 'designs-archive'));
      writeFileSync(
        join(tree, 'designs-archive', 'old.md'),
        "archived content with an \u2014 emdash\n",
      );
      const r = runLint(tree, ['--rule=emdash']);
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain('[emdash]');
    });

    it('DOES match the exact prefix directory (design/foo.md)', () => {
      mkdirSync(join(tree, 'design'));
      writeFileSync(
        join(tree, 'design', 'spec.md'),
        "spec with an \u2014 emdash\n",
      );
      const r = runLint(tree, ['--rule=emdash']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('[emdash]');
      expect(r.stderr).toContain('design/spec.md:1');
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
