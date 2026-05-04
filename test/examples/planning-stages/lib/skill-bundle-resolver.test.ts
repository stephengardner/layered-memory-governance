/**
 * Tests for the skill-bundle-resolver.
 *
 * Covers:
 *   - Vendored fallback when no plugin cache is present.
 *   - In-process cache hit on second call.
 *   - Unsupported skill name rejected.
 *   - Plugin-cache priority over vendored when both are present.
 *   - Throws SkillBundleNotFoundError when neither path resolves.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SUPPORTED_SKILLS,
  SkillBundleNotFoundError,
  resolveSkillBundle,
  _resetSkillBundleCacheForTests,
} from '../../../../examples/planning-stages/lib/skill-bundle-resolver.js';

describe('resolveSkillBundle', () => {
  beforeEach(() => {
    _resetSkillBundleCacheForTests();
  });

  it('falls back to the vendored copy when the plugin cache is absent', async () => {
    const result = await resolveSkillBundle('brainstorming', {
      skipPluginCache: true,
    });
    expect(result).toContain('Brainstorming skill');
    expect(result.length).toBeGreaterThan(200);
  });

  it('throws SkillBundleNotFoundError when neither path resolves (skip plugin + bogus vendored dir)', async () => {
    // Use an empty homeDir so the plugin-cache lookup definitely fails;
    // unsupported skill triggers the early supported-list reject.
    await expect(
      resolveSkillBundle('not-a-real-skill-name', { skipPluginCache: true }),
    ).rejects.toThrow(/unsupported skill name/);
  });

  it('caches the resolved bundle in-process', async () => {
    const first = await resolveSkillBundle('brainstorming', {
      skipPluginCache: true,
    });
    const second = await resolveSkillBundle('brainstorming', {
      skipPluginCache: true,
    });
    expect(second).toBe(first);
  });

  it('prefers the plugin-cache copy when both are present', async () => {
    const tmp = await fs.mkdtemp(join(tmpdir(), 'skill-resolver-test-'));
    const cacheDir = join(
      tmp,
      '.claude',
      'plugins',
      'cache',
      'claude-plugins-official',
      'superpowers',
      '5.0.5',
      'skills',
      'brainstorming',
    );
    await fs.mkdir(cacheDir, { recursive: true });
    const sentinel = '# plugin-cache version sentinel\n';
    await fs.writeFile(join(cacheDir, 'SKILL.md'), sentinel);
    const result = await resolveSkillBundle('brainstorming', { homeDir: tmp });
    expect(result).toBe(sentinel);
  });

  it('exports a non-empty SUPPORTED_SKILLS list', () => {
    expect(SUPPORTED_SKILLS.length).toBeGreaterThan(0);
    expect(SUPPORTED_SKILLS).toContain('brainstorming');
    expect(SUPPORTED_SKILLS).toContain('writing-plans');
  });

  it('SkillBundleNotFoundError surfaces the searched paths', () => {
    const err = new SkillBundleNotFoundError('foo', ['plugin:/x', 'vendored:/y']);
    expect(err.message).toContain('plugin:/x');
    expect(err.message).toContain('vendored:/y');
    expect(err.name).toBe('SkillBundleNotFoundError');
  });
});
