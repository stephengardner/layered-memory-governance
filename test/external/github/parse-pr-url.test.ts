/**
 * Unit tests for the github PR URL parser.
 *
 * Lives next to the GitHub external-system adapter rather than under
 * src/runtime/, since the canonical github.com URL shape is forge-
 * specific and substrate-purity dictates that vendor-specific knowledge
 * stays out of `src/runtime/`.
 */

import { describe, expect, it } from 'vitest';
import { parsePrHtmlUrl } from '../../../src/external/github/parse-pr-url.js';

describe('parsePrHtmlUrl', () => {
  it('parses a canonical github.com PR URL', () => {
    const r = parsePrHtmlUrl('https://github.com/foo/bar/pull/42');
    expect(r).toEqual({ owner: 'foo', repo: 'bar', number: 42 });
  });

  it('parses a real-world repo with hyphens and digits', () => {
    const r = parsePrHtmlUrl('https://github.com/stephengardner/layered-autonomous-governance/pull/344');
    expect(r).toEqual({
      owner: 'stephengardner',
      repo: 'layered-autonomous-governance',
      number: 344,
    });
  });

  it('handles trailing slash', () => {
    const r = parsePrHtmlUrl('https://github.com/foo/bar/pull/42/');
    expect(r).toEqual({ owner: 'foo', repo: 'bar', number: 42 });
  });

  it('handles trailing path segments after the number (anchors, files, etc.)', () => {
    // GitHub PR URLs sometimes have additional path: /pull/42/files,
    // /pull/42/commits, /pull/42#issuecomment-xxx. Parser stops at
    // the number segment.
    const r = parsePrHtmlUrl('https://github.com/foo/bar/pull/42/files');
    expect(r).toEqual({ owner: 'foo', repo: 'bar', number: 42 });
  });

  it('throws on non-string input', () => {
    // @ts-expect-error -- testing runtime guard
    expect(() => parsePrHtmlUrl(undefined)).toThrow(/non-empty string/);
    // @ts-expect-error -- testing runtime guard
    expect(() => parsePrHtmlUrl(123)).toThrow(/non-empty string/);
    expect(() => parsePrHtmlUrl('')).toThrow(/non-empty string/);
  });

  it('throws on missing scheme', () => {
    expect(() => parsePrHtmlUrl('github.com/foo/bar/pull/42')).toThrow(/not a valid URL/);
  });

  it('throws on non-http(s) scheme', () => {
    expect(() => parsePrHtmlUrl('ftp://github.com/foo/bar/pull/42')).toThrow(/scheme must be http\(s\)/);
  });

  it('throws on non-github host', () => {
    expect(() => parsePrHtmlUrl('https://gitlab.com/foo/bar/pull/42')).toThrow(/host must be github\.com/);
    expect(() => parsePrHtmlUrl('https://api.github.com/foo/bar/pull/42')).toThrow(/host must be github\.com/);
  });

  it('throws when the pull segment is missing', () => {
    expect(() => parsePrHtmlUrl('https://github.com/foo/bar/issues/42')).toThrow(/segment 3 must be 'pull'/);
  });

  it('throws when the path is too short', () => {
    expect(() => parsePrHtmlUrl('https://github.com/foo/bar')).toThrow(/too few segments/);
  });

  it('throws when the number segment is not a positive integer', () => {
    expect(() => parsePrHtmlUrl('https://github.com/foo/bar/pull/abc')).toThrow(/not a positive integer/);
    expect(() => parsePrHtmlUrl('https://github.com/foo/bar/pull/1.5')).toThrow(/not a positive integer/);
    expect(() => parsePrHtmlUrl('https://github.com/foo/bar/pull/0')).toThrow(/not a positive integer/);
    expect(() => parsePrHtmlUrl('https://github.com/foo/bar/pull/-3')).toThrow(/not a positive integer/);
  });
});
