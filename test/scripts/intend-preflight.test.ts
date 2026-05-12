import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve as resolvePath, join } from 'node:path';
import {
  runPreflight,
  formatPreflightError,
  extractCitedPaths,
  resolveCitedPath,
  isRepoRootBareName,
  lineDeclaresCreateIntent,
} from '../../scripts/lib/intend-preflight.mjs';

/**
 * Construct a temp directory and populate it with the given paths (relative
 * to the temp root). Returns the absolute path of the temp root so tests can
 * use it as `repoRoot`. Uses node:fs/promises directly (no test helper) so
 * the test is self-contained and the mock vs real toggle is visible at the
 * call site.
 */
async function makeRepoFixture(paths: ReadonlyArray<string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lag-intend-preflight-'));
  for (const rel of paths) {
    const absolute = resolvePath(root, rel);
    const dir = absolute.includes('/') || absolute.includes('\\')
      ? absolute.slice(0, Math.max(absolute.lastIndexOf('/'), absolute.lastIndexOf('\\')))
      : root;
    await mkdir(dir, { recursive: true });
    await writeFile(absolute, '');
  }
  return root;
}

describe('extractCitedPaths', () => {
  it('captures a multi-segment path-shaped token', () => {
    const paths = extractCitedPaths('Please update apps/console/README.md to add X');
    expect(paths.map(p => p.token)).toEqual(['apps/console/README.md']);
    expect(paths[0]?.lineNumber).toBe(1);
  });

  it('captures bare filenames with known extensions', () => {
    const paths = extractCitedPaths('Open README.md and check.');
    expect(paths.map(p => p.token)).toEqual(['README.md']);
  });

  it('ignores http and https URLs even when path-shaped tokens follow', () => {
    const paths = extractCitedPaths('See https://example.com/foo.html for details');
    expect(paths.map(p => p.token)).toEqual([]);
  });

  it('does not capture version strings as path-shaped tokens', () => {
    const paths = extractCitedPaths('Bump dependency to 1.2.3 and 0.9.4');
    expect(paths.map(p => p.token)).toEqual([]);
  });

  it('captures multiple paths from a multi-line request body', () => {
    const body = 'Touch the following:\n- apps/console/server/index.ts\n- src/runtime/loop/runner.ts\n';
    const paths = extractCitedPaths(body);
    expect(paths.map(p => p.token)).toEqual([
      'apps/console/server/index.ts',
      'src/runtime/loop/runner.ts',
    ]);
  });

  it('returns empty array for prose with no path-shaped tokens', () => {
    expect(extractCitedPaths('Improve the deliberation copy')).toEqual([]);
    expect(extractCitedPaths('')).toEqual([]);
  });

  it('captures dot-prefixed config files with recognized extensions', () => {
    // .eslintrc.json has the .json extension on PATH_EXT, so the regex
    // captures it. .env.example does NOT have a recognized extension
    // (`example` is not in PATH_EXT); operators citing .env.example would
    // need to use the explicit .env.example bare-allowlist path -- handled
    // via the bare-filename branch in resolveCitedPath when isRepoRootBareName
    // returns true.
    const paths = extractCitedPaths('Edit .eslintrc.json to add a rule');
    expect(paths.map(p => p.token)).toEqual(['.eslintrc.json']);
  });

  it('records line number for paths spread across lines', () => {
    const body = 'top text\nsecond line README.md\nthird line';
    const paths = extractCitedPaths(body);
    expect(paths).toHaveLength(1);
    expect(paths[0]?.token).toBe('README.md');
    expect(paths[0]?.lineNumber).toBe(2);
  });
});

describe('isRepoRootBareName', () => {
  it('allows well-known top-level files', () => {
    expect(isRepoRootBareName('README.md')).toBe(true);
    expect(isRepoRootBareName('package.json')).toBe(true);
    expect(isRepoRootBareName('CLAUDE.md')).toBe(true);
    expect(isRepoRootBareName('.env')).toBe(true);
    expect(isRepoRootBareName('.env.example')).toBe(true);
  });

  it('allows tsconfig.<flavor>.json pattern', () => {
    expect(isRepoRootBareName('tsconfig.json')).toBe(true);
    expect(isRepoRootBareName('tsconfig.examples.json')).toBe(true);
    expect(isRepoRootBareName('tsconfig.typecheck.json')).toBe(true);
  });

  it('rejects random leaf-only paths', () => {
    expect(isRepoRootBareName('foo.ts')).toBe(false);
    expect(isRepoRootBareName('Header.tsx')).toBe(false);
    expect(isRepoRootBareName('random.config.ts')).toBe(false);
  });
});

describe('lineDeclaresCreateIntent', () => {
  it('detects create verbs', () => {
    expect(lineDeclaresCreateIntent('please create a new file at foo/bar.ts')).toBe(true);
    expect(lineDeclaresCreateIntent('add new file foo/bar.ts')).toBe(true);
    expect(lineDeclaresCreateIntent('introduce a new module x/y.ts')).toBe(true);
    expect(lineDeclaresCreateIntent('generate a fixture at test/fixture.json')).toBe(true);
  });

  it('does not false-positive on substrings (address, newsletter)', () => {
    expect(lineDeclaresCreateIntent('update the address book at addr.json')).toBe(false);
    expect(lineDeclaresCreateIntent('open newsletter.md')).toBe(false);
  });

  it('returns false on lines without create-shaped verbs', () => {
    expect(lineDeclaresCreateIntent('update apps/console/README.md to add X')).toBe(true);
    // Note: 'add' is a create-shaped verb. Test that purely citation lines
    // without those verbs return false.
    expect(lineDeclaresCreateIntent('see apps/console/README.md for context')).toBe(false);
    expect(lineDeclaresCreateIntent('the file is apps/console/server/index.ts')).toBe(false);
  });
});

describe('resolveCitedPath', () => {
  it('resolves a slashed path against repo root', () => {
    expect(resolveCitedPath('apps/console/README.md', '/repo'))
      .toBe(resolvePath('/repo', 'apps/console/README.md'));
  });

  it('resolves a bare filename against repo root', () => {
    expect(resolveCitedPath('README.md', '/repo'))
      .toBe(resolvePath('/repo', 'README.md'));
  });

  it('throws on empty inputs', () => {
    expect(() => resolveCitedPath('', '/repo')).toThrow(/token/);
    expect(() => resolveCitedPath('foo.ts', '')).toThrow(/repoRoot/);
  });
});

describe('runPreflight', () => {
  it('passes through when every cited path exists', async () => {
    const root = await makeRepoFixture(['apps/console/README.md']);
    const result = await runPreflight({
      request: 'Update apps/console/README.md to add X',
      repoRoot: root,
    });
    // 'add X' triggers verb heuristic but path also exists, so checked
    // remains populated either way. Critically: ok must be true.
    expect(result.ok).toBe(true);
  });

  it('halts on a single unreachable path', async () => {
    const root = await makeRepoFixture([]);
    const result = await runPreflight({
      request: 'Update apps/console/README.md to fix typo',
      repoRoot: root,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing.map(m => m.token)).toEqual(['apps/console/README.md']);
    expect(result.missing[0]?.errCode).toBe('ENOENT');
  });

  it('passes through on a request with no path-shaped tokens', async () => {
    const root = await makeRepoFixture([]);
    const result = await runPreflight({
      request: 'Improve the deliberation copy',
      repoRoot: root,
    });
    expect(result.ok).toBe(true);
  });

  it('resolves bare README.md against repo root and passes', async () => {
    const root = await makeRepoFixture(['README.md']);
    const result = await runPreflight({
      request: 'See README.md for setup details',
      repoRoot: root,
    });
    expect(result.ok).toBe(true);
  });

  it('halts when a bare filename does not exist at repo root', async () => {
    const root = await makeRepoFixture([]);
    const result = await runPreflight({
      request: 'See MISSING.md for setup details',
      repoRoot: root,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing.map(m => m.token)).toEqual(['MISSING.md']);
  });

  it('does not flag URLs containing path-shaped tail tokens', async () => {
    const root = await makeRepoFixture([]);
    const result = await runPreflight({
      request: 'Reference https://example.com/foo.html in the doc',
      repoRoot: root,
    });
    expect(result.ok).toBe(true);
  });

  it('--force-paths bypass: missing path becomes warning, ok stays true', async () => {
    const root = await makeRepoFixture([]);
    const result = await runPreflight({
      request: 'Touch apps/console/README.md to fix it',
      repoRoot: root,
      forcePaths: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.forced).toBe(true);
    expect(result.warnings.map(w => w.token)).toEqual(['apps/console/README.md']);
  });

  it('verb heuristic: CREATE intent passes preflight without path existing', async () => {
    const root = await makeRepoFixture([]);
    const result = await runPreflight({
      request: 'add new file foo/bar.ts',
      repoRoot: root,
    });
    expect(result.ok).toBe(true);
  });

  it('--skip-preflight returns ok without filesystem access', async () => {
    // Pass a missing path; with skipPreflight: true, the validator must NOT
    // touch the filesystem at all. Use a vi.fn to confirm fsAccess was never
    // invoked.
    const fsAccess = vi.fn();
    const result = await runPreflight({
      request: 'apps/console/MISSING.md needs editing',
      repoRoot: '/nonexistent',
      skipPreflight: true,
      fsAccess,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skipped).toBe(true);
    expect(fsAccess).not.toHaveBeenCalled();
  });

  it('captures both existing and missing paths in the same request body', async () => {
    const root = await makeRepoFixture(['apps/console/server/index.ts']);
    const result = await runPreflight({
      request: 'Touch apps/console/server/index.ts and src/runtime/MISSING.ts',
      repoRoot: root,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing.map(m => m.token)).toEqual(['src/runtime/MISSING.ts']);
    // The verb 'Touch' is not on the create-verb list (the operator is
    // editing an existing file), so the existing file is checked + passes.
    expect(result.checked.some(c => c.token === 'apps/console/server/index.ts' && c.status === 'exists')).toBe(true);
  });

  it('throws on non-string request', async () => {
    await expect(runPreflight({ request: null as unknown as string, repoRoot: '/r' }))
      .rejects.toThrow(/request/);
  });

  it('throws on empty repoRoot', async () => {
    await expect(runPreflight({ request: 'x', repoRoot: '' }))
      .rejects.toThrow(/repoRoot/);
  });
});

describe('formatPreflightError', () => {
  it('formats a single missing path with ENOENT', () => {
    const out = formatPreflightError([
      { token: 'apps/console/README.md', line: 'Update apps/console/README.md', lineNumber: 1, absolute: '/repo/apps/console/README.md', errCode: 'ENOENT' },
    ]);
    expect(out).toContain('pre-flight FAILED');
    expect(out).toContain('apps/console/README.md');
    expect(out).toContain('no such file or directory');
    expect(out).toContain('--force-paths');
    expect(out).toContain('--skip-preflight');
  });

  it('formats multiple missing paths', () => {
    const out = formatPreflightError([
      { token: 'a.md', line: 'a.md', lineNumber: 1, absolute: '/r/a.md', errCode: 'ENOENT' },
      { token: 'b.md', line: 'b.md', lineNumber: 2, absolute: '/r/b.md', errCode: 'ENOENT' },
    ]);
    expect(out).toContain('a.md');
    expect(out).toContain('b.md');
  });

  it('surfaces non-ENOENT codes verbatim', () => {
    const out = formatPreflightError([
      { token: 'a.md', line: 'a.md', lineNumber: 1, absolute: '/r/a.md', errCode: 'EACCES' },
    ]);
    expect(out).toContain('fs.access error EACCES');
  });

  it('throws on empty missing array (programmer error guard)', () => {
    expect(() => formatPreflightError([])).toThrow();
  });
});

describe('runPreflight argument-parse contract for --force-paths and --skip-preflight', () => {
  // This test verifies the flag wiring through parseIntendArgs to runPreflight.
  // The parsing side of the contract is covered in test/scripts/intend.test.ts;
  // here we pin that the runPreflight option shape is consumed correctly.
  it('accepts both bypass flags from caller without throwing', async () => {
    const result = await runPreflight({
      request: 'no paths cited',
      repoRoot: '/anywhere',
      forcePaths: true,
      skipPreflight: true,
    });
    // skipPreflight short-circuits BEFORE forcePaths is consulted, so the
    // result is { ok: true, skipped: true }.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skipped).toBe(true);
  });
});
