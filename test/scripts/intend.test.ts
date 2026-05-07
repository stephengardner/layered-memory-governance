import { describe, expect, it } from 'vitest';
import {
  parseIntendArgs,
  buildIntentAtom,
  computeExpiresAt,
  buildCtoSpawnArgs,
  shellQuote,
} from '../../scripts/lib/intend.mjs';

describe('parseIntendArgs', () => {
  it('parses required --request + --scope + --blast-radius', () => {
    const r = parseIntendArgs([
      '--request', 'fix the CTO',
      '--scope', 'tooling',
      '--blast-radius', 'framework',
      '--sub-actors', 'code-author',
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.request).toBe('fix the CTO');
    expect(r.args.scope).toBe('tooling');
    expect(r.args.blastRadius).toBe('framework');
    expect(r.args.subActors).toEqual(['code-author']);
  });

  it('accepts multiple --sub-actors values (comma or repeated)', () => {
    const r = parseIntendArgs(['--request', 'x', '--scope', 'tooling', '--blast-radius', 'tooling', '--sub-actors', 'code-author,auditor-actor']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.subActors).toEqual(['code-author', 'auditor-actor']);
  });

  it('rejects invalid blast-radius', () => {
    const r = parseIntendArgs(['--request', 'x', '--scope', 'tooling', '--blast-radius', 'everything', '--sub-actors', 'code-author']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/blast-radius/i);
  });

  it('rejects missing --request', () => {
    const r = parseIntendArgs(['--scope', 'tooling', '--blast-radius', 'tooling', '--sub-actors', 'code-author']);
    expect(r.ok).toBe(false);
  });

  it('accepts optional --expires-in', () => {
    const r = parseIntendArgs(['--request', 'x', '--scope', 'tooling', '--blast-radius', 'tooling', '--sub-actors', 'code-author', '--expires-in', '6h']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.expiresIn).toBe('6h');
  });

  it('accepts --dry-run flag', () => {
    const r = parseIntendArgs(['--request', 'x', '--scope', 'tooling', '--blast-radius', 'tooling', '--sub-actors', 'code-author', '--dry-run']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.dryRun).toBe(true);
  });

  it('accepts --invokers <path> for deployment-specific override', () => {
    const r = parseIntendArgs([
      '--request', 'x', '--scope', 'tooling', '--blast-radius', 'tooling',
      '--sub-actors', 'code-author',
      '--invokers', '/custom/registrar.mjs',
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.invokersPath).toBe('/custom/registrar.mjs');
  });

  it('defaults invokersPath to null when --invokers omitted', () => {
    const r = parseIntendArgs([
      '--request', 'x', '--scope', 'tooling', '--blast-radius', 'tooling',
      '--sub-actors', 'code-author',
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.invokersPath).toBe(null);
  });
});

describe('shellQuote', () => {
  it('leaves shell-safe tokens unwrapped', () => {
    expect(shellQuote('hello')).toBe('hello');
    expect(shellQuote('intent-abc-123')).toBe('intent-abc-123');
    expect(shellQuote('/abs/path/to/file.mjs')).toBe('/abs/path/to/file.mjs');
  });

  it('wraps tokens containing whitespace', () => {
    expect(shellQuote('hello world')).toBe(`'hello world'`);
  });

  it('escapes embedded single quotes via close-reopen idiom', () => {
    expect(shellQuote(`it's a quote`)).toBe(`'it'\\''s a quote'`);
  });

  it('quotes tokens with shell metacharacters', () => {
    expect(shellQuote('echo $HOME')).toBe(`'echo $HOME'`);
    expect(shellQuote('foo;bar')).toBe(`'foo;bar'`);
    expect(shellQuote('back`tick`')).toBe(`'back\`tick\`'`);
    expect(shellQuote('with"quote')).toBe(`'with"quote'`);
    expect(shellQuote('back\\slash')).toBe(`'back\\slash'`);
  });

  it('returns empty quoted-string for empty input', () => {
    expect(shellQuote('')).toBe(`''`);
  });

  it('rejects non-string input', () => {
    // @ts-expect-error verifying runtime guard
    expect(() => shellQuote(123)).toThrow(/string/);
  });
});

describe('computeExpiresAt', () => {
  const now = new Date('2026-04-24T12:00:00Z');
  it('defaults to +24h when unset', () => {
    expect(computeExpiresAt(undefined, now)).toBe('2026-04-25T12:00:00.000Z');
  });
  it('accepts 6h', () => {
    expect(computeExpiresAt('6h', now)).toBe('2026-04-24T18:00:00.000Z');
  });
  it('accepts 30m', () => {
    expect(computeExpiresAt('30m', now)).toBe('2026-04-24T12:30:00.000Z');
  });
  it('rejects over 72h (safety cap)', () => {
    expect(() => computeExpiresAt('73h', now)).toThrow(/72/);
  });
  it('rejects invalid format', () => {
    expect(() => computeExpiresAt('tomorrow', now)).toThrow();
  });
});

describe('buildCtoSpawnArgs', () => {
  const baseSpec = {
    runCtoActorPath: '/repo/scripts/run-cto-actor.mjs',
    request: 'add a hover tooltip',
    atomId: 'intent-abc-2026-05-06T03-18-38-365Z',
    invokersPath: '/repo/scripts/invokers/autonomous-dispatch.mjs',
  };

  it('always includes --invokers in the spawn argv', () => {
    const argv = buildCtoSpawnArgs(baseSpec);
    const idx = argv.indexOf('--invokers');
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe(baseSpec.invokersPath);
  });

  it('preserves canonical positional + flag order', () => {
    const argv = buildCtoSpawnArgs(baseSpec);
    expect(argv).toEqual([
      baseSpec.runCtoActorPath,
      '--request', baseSpec.request,
      '--intent-id', baseSpec.atomId,
      '--invokers', baseSpec.invokersPath,
    ]);
  });

  it('rejects empty runCtoActorPath', () => {
    expect(() => buildCtoSpawnArgs({ ...baseSpec, runCtoActorPath: '' })).toThrow(/runCtoActorPath/);
  });

  it('rejects empty invokersPath', () => {
    expect(() => buildCtoSpawnArgs({ ...baseSpec, invokersPath: '' })).toThrow(/invokersPath/);
  });

  it('rejects empty request', () => {
    expect(() => buildCtoSpawnArgs({ ...baseSpec, request: '' })).toThrow(/request/);
  });

  it('rejects empty atomId', () => {
    expect(() => buildCtoSpawnArgs({ ...baseSpec, atomId: '' })).toThrow(/atomId/);
  });
});

describe('buildIntentAtom', () => {
  it('constructs a well-formed atom from validated args', () => {
    const atom = buildIntentAtom({
      request: 'fix X',
      scope: 'tooling',
      blastRadius: 'framework',
      subActors: ['code-author'],
      minConfidence: 0.75,
      expiresAt: '2026-04-25T12:00:00.000Z',
      operatorPrincipalId: 'operator-principal',
      now: new Date('2026-04-24T12:00:00Z'),
      nonce: 'abc123',
    });
    expect(atom.type).toBe('operator-intent');
    expect(atom.layer).toBe('L1');
    expect(atom.principal_id).toBe('operator-principal');
    expect(atom.id.startsWith('intent-')).toBe(true);
    expect(atom.metadata.kind).toBe('autonomous-solve');
    expect(atom.metadata.trust_envelope.max_blast_radius).toBe('framework');
    expect(atom.metadata.trust_envelope.allowed_sub_actors).toEqual(['code-author']);
    expect(atom.metadata.trust_envelope.min_plan_confidence).toBe(0.75);
    expect(atom.metadata.trust_envelope.require_ci_green).toBe(true);
    expect(atom.metadata.trust_envelope.require_cr_approve).toBe(true);
    expect(atom.metadata.trust_envelope.require_auditor_observation).toBe(true);
    expect(atom.metadata.expires_at).toBe('2026-04-25T12:00:00.000Z');
    expect(atom.provenance.kind).toBe('operator-seeded');
    expect(atom.confidence).toBe(1);
    expect(atom.taint).toBe('clean');
  });
});
