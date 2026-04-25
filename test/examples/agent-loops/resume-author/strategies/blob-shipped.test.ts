import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobShippedSessionResumeStrategy, type BlobShippedStrategyOptions } from '../../../../../examples/agent-loops/resume-author/strategies/blob-shipped.js';
import { FileBlobStore } from '../../../../../examples/blob-stores/file/blob-store.js';
import { blobRefFromHash } from '../../../../../src/substrate/blob-store.js';
import type {
  BlobStore,
  BlobRef,
  BlobStorageDescriptor,
} from '../../../../../src/substrate/blob-store.js';
import type { Redactor, RedactContext } from '../../../../../src/substrate/redactor.js';
import type { CandidateSession, ResumeContext } from '../../../../../examples/agent-loops/resume-author/types.js';
import type { Workspace } from '../../../../../src/substrate/workspace-provider.js';
import type { Host } from '../../../../../src/substrate/interface.js';
import type { AtomId, PrincipalId } from '../../../../../src/substrate/types.js';

// Stub workspace + host. The strategy only reads `workspace.path`; Host is
// passed straight through to onSessionPersist input but the strategy never
// touches its fields. Cast through `unknown` to a narrow type rather than
// any, satisfying the architectural no-explicit-any guard.
const stubWs = { id: 'ws-1', path: '/tmp/some/workspace', baseRef: 'main' } as Workspace;
const stubHost = {} as unknown as Host;

/**
 * A redactor that aggressively transforms input. Used to satisfy the
 * identity-rejection guard so other tests can construct successfully.
 */
const tunedRedactor: Redactor = {
  redact: (content: string, _ctx: RedactContext) => {
    // Match the same patterns the regex-default redactor handles, but with a
    // local replacement so this stub stays self-contained.
    return content
      .replace(/\bgh[pur]_[A-Za-z0-9]{36}\b/g, '[REDACTED:gh-pat]')
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws]')
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED:jwt]');
  },
};

const identityRedactor: Redactor = { redact: (x: string) => x };

/**
 * Build a stub remote BlobStore. Only describeStorage + put + get + has are
 * exercised by the strategy.
 */
function makeRemoteBlobStore(target: string): BlobStore {
  const store = new Map<string, Buffer>();
  return {
    async put(content: Buffer | string): Promise<BlobRef> {
      const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
      const { createHash } = await import('node:crypto');
      const hex = createHash('sha256').update(buf).digest('hex');
      const ref = blobRefFromHash(hex);
      store.set(ref, buf);
      return ref;
    },
    async get(ref: BlobRef): Promise<Buffer> {
      const v = store.get(ref);
      if (v === undefined) throw new Error(`blob not found: ${ref}`);
      return v;
    },
    async has(ref: BlobRef): Promise<boolean> {
      return store.has(ref);
    },
    describeStorage(): BlobStorageDescriptor {
      return { kind: 'remote', target };
    },
  };
}

let tmpRoot: string;
let outsideGitRoot: string;
let insideGitRoot: string;
let outsideGitBs: FileBlobStore;
let homeOverride: string;

/**
 * Build a `_testFsExists` probe scoped to a specific "inside-git-tree"
 * prefix. The strategy's destination guard probes for `.git/` while
 * walking up from the rootPath; on a developer machine the user's home
 * directory may itself sit inside a git tree (~/.git/), which would
 * false-positive the guard. The injected probe returns `true` only when
 * the queried `.git` path falls under the explicit insideGitTreePrefix.
 */
function fsExistsScopedTo(insideGitTreePrefix: string) {
  return (p: string): boolean => {
    if (p.endsWith('.git') || p.endsWith('.git/') || p.endsWith('.git\\')) {
      return p.startsWith(insideGitTreePrefix);
    }
    return false;
  };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'blob-shipped-test-'));
  outsideGitRoot = join(tmpRoot, 'outside-git', 'blobs');
  mkdirSync(outsideGitRoot, { recursive: true });
  // Inside-git: a fake git tree under tmpRoot. The injected fsExists
  // returns `true` only for `.git` probes under this prefix.
  insideGitRoot = join(tmpRoot, 'inside-git');
  mkdirSync(join(insideGitRoot, '.git'), { recursive: true });
  mkdirSync(join(insideGitRoot, 'blobs'), { recursive: true });

  outsideGitBs = new FileBlobStore(outsideGitRoot);

  // Fake $HOME for preparation/onSessionPersist tests so we never touch the
  // real home directory.
  homeOverride = join(tmpRoot, 'fake-home');
  mkdirSync(homeOverride, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Build options for an outside-git construction. Used pervasively by
 * tests that just need the strategy to construct successfully so the
 * test can exercise its actual behavior. The `extra` slot accepts both
 * BlobShippedStrategyOptions field overrides AND deliberately-malformed
 * values (e.g. `acknowledgeSessionDataFlow: false` to test the guard);
 * the resulting object is cast back to BlobShippedStrategyOptions at the
 * constructor call site, where the test asserts a throw.
 */
function buildOutsideOpts(
  extra: Record<string, unknown> = {},
): BlobShippedStrategyOptions {
  const opts: Record<string, unknown> = {
    acknowledgeSessionDataFlow: true,
    redactor: tunedRedactor,
    blobStore: outsideGitBs,
    cliVersion: '2.0.0',
    homeDirOverride: homeOverride,
    _testFsExists: fsExistsScopedTo(insideGitRoot),
    ...extra,
  };
  return opts as unknown as BlobShippedStrategyOptions;
}

describe('BlobShippedSessionResumeStrategy -- construction guards', () => {
  it('throws when acknowledgeSessionDataFlow is missing', () => {
    expect(() => new BlobShippedSessionResumeStrategy(buildOutsideOpts({
      acknowledgeSessionDataFlow: undefined,
    }))).toThrow(/acknowledgeSessionDataFlow/);
  });

  it('throws when acknowledgeSessionDataFlow is false', () => {
    expect(() => new BlobShippedSessionResumeStrategy(buildOutsideOpts({
      acknowledgeSessionDataFlow: false,
    }))).toThrow(/acknowledgeSessionDataFlow/);
  });

  it('throws when acknowledgeSessionDataFlow is a truthy non-true value', () => {
    expect(() => new BlobShippedSessionResumeStrategy(buildOutsideOpts({
      acknowledgeSessionDataFlow: 1,  // truthy but not literal true
    }))).toThrow(/acknowledgeSessionDataFlow/);
  });

  it('throws when redactor is undefined', () => {
    expect(() => new BlobShippedSessionResumeStrategy(buildOutsideOpts({
      redactor: undefined,
    }))).toThrow(/redactor/);
  });

  it('throws when redactor is null', () => {
    expect(() => new BlobShippedSessionResumeStrategy(buildOutsideOpts({
      redactor: null,
    }))).toThrow(/redactor/);
  });

  it('throws when redactor is identity', () => {
    expect(() => new BlobShippedSessionResumeStrategy(buildOutsideOpts({
      redactor: identityRedactor,
    }))).toThrow(/identity|redactor/i);
  });

  it('throws when cliVersion is missing', () => {
    expect(() => new BlobShippedSessionResumeStrategy(buildOutsideOpts({
      cliVersion: undefined,
    }))).toThrow(/cliVersion/);
  });

  it('throws when cliVersion is empty string', () => {
    expect(() => new BlobShippedSessionResumeStrategy(buildOutsideOpts({
      cliVersion: '',
    }))).toThrow(/cliVersion/);
  });

  it('throws when blobStore.describeStorage() rootPath is inside a git tree (immediate parent)', () => {
    const bs = new FileBlobStore(join(insideGitRoot, 'blobs'));
    expect(() => new BlobShippedSessionResumeStrategy(buildOutsideOpts({
      blobStore: bs,
    }))).toThrow(/git-tracked|git tree|\.git/i);
  });

  it('throws when blobStore.describeStorage() rootPath is the .git directory itself', () => {
    // Edge case: rootPath IS the .git dir. The walk-up from .git/ checks .git/.git which
    // does not exist; then checks .git's parent which is the git tree itself; should still
    // detect by walking up from the rootPath.
    const dotGitInside = join(insideGitRoot, '.git', 'blobs');
    mkdirSync(dotGitInside, { recursive: true });
    const bs = new FileBlobStore(dotGitInside);
    expect(() => new BlobShippedSessionResumeStrategy(buildOutsideOpts({
      blobStore: bs,
    }))).toThrow(/git-tracked|git tree|\.git/i);
  });

  it('does not throw when blobStore.describeStorage() rootPath is outside any git tree', () => {
    expect(() => new BlobShippedSessionResumeStrategy(buildOutsideOpts())).not.toThrow();
  });

  it('logs INFO and proceeds when blobStore is kind: remote', () => {
    const bs = makeRemoteBlobStore('s3://bucket/prefix');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      // Remote BlobStore: the local-file destination guard is bypassed
      // entirely; no `_testFsExists` injection needed.
      expect(() => new BlobShippedSessionResumeStrategy({
        acknowledgeSessionDataFlow: true,
        redactor: tunedRedactor,
        blobStore: bs,
        cliVersion: '2.0.0',
      })).not.toThrow();
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringMatching(/BlobShipped.*remote.*s3:\/\/bucket\/prefix/i),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });
});

describe('BlobShippedSessionResumeStrategy -- findResumableSession', () => {
  function makeCandidate(overrides: Partial<CandidateSession> = {}): CandidateSession {
    return {
      sessionAtomId: 'session-atom-1' as AtomId,
      resumableSessionId: 'cli-uuid-1',
      startedAt: new Date().toISOString(),
      extra: {},
      adapterId: 'claude-code-agent-loop',
      ...overrides,
    };
  }

  function makeCtx(candidates: ReadonlyArray<CandidateSession>): ResumeContext {
    return { candidateSessions: candidates, workspace: stubWs, host: stubHost };
  }

  it('returns null when no candidates', async () => {
    const s = new BlobShippedSessionResumeStrategy(buildOutsideOpts());
    expect(await s.findResumableSession(makeCtx([]))).toBeNull();
  });

  it('returns null when no candidate has session_file_blob_ref in extra', async () => {
    const s = new BlobShippedSessionResumeStrategy(buildOutsideOpts());
    const c = makeCandidate({ extra: { cli_version: '2.0.0' } });  // no blob_ref
    expect(await s.findResumableSession(makeCtx([c]))).toBeNull();
  });

  it('returns null when cli_version mismatches (rejects, does not throw)', async () => {
    const s = new BlobShippedSessionResumeStrategy(buildOutsideOpts());
    const c = makeCandidate({
      extra: {
        session_file_blob_ref: 'sha256:' + 'a'.repeat(64),
        cli_version: '1.9.0',  // mismatch
      },
    });
    expect(await s.findResumableSession(makeCtx([c]))).toBeNull();
  });

  it('skips candidates produced by an incompatible adapter id', async () => {
    const s = new BlobShippedSessionResumeStrategy(buildOutsideOpts());
    const c = makeCandidate({
      adapterId: 'langgraph',  // not claude-code-agent-loop
      extra: {
        session_file_blob_ref: 'sha256:' + 'a'.repeat(64),
        cli_version: '2.0.0',
      },
    });
    expect(await s.findResumableSession(makeCtx([c]))).toBeNull();
  });

  it('returns ResolvedSession with preparation closure on match', async () => {
    // Pre-populate the blob store with session bytes so preparation can find them.
    const sessionBytes = Buffer.from('{"event":"session-init"}\n', 'utf8');
    const ref = await outsideGitBs.put(sessionBytes);
    const s = new BlobShippedSessionResumeStrategy(buildOutsideOpts());
    const c = makeCandidate({
      sessionAtomId: 'sess-atom-X' as AtomId,
      resumableSessionId: 'fresh-uuid-X',
      extra: {
        session_file_blob_ref: ref,
        cli_version: '2.0.0',
      },
    });
    const r = await s.findResumableSession(makeCtx([c]));
    expect(r).not.toBeNull();
    expect(r!.resumableSessionId).toBe('fresh-uuid-X');
    expect(r!.resumedFromSessionAtomId).toBe('sess-atom-X');
    expect(r!.strategyName).toBe('blob-shipped');
    expect(typeof r!.preparation).toBe('function');
  });

  it('preparation closure writes .jsonl to <home>/.claude/projects/<derived-slug>/<uuid>.jsonl with mode 0600', async () => {
    const sessionBytes = Buffer.from('{"event":"resumed"}\n', 'utf8');
    const ref = await outsideGitBs.put(sessionBytes);
    const cwd = '/Users/op/memory-governance';
    const expectedSlug = 'Users-op-memory-governance';
    const ws = { id: 'ws-1', path: cwd, baseRef: 'main' } as Workspace;
    const s = new BlobShippedSessionResumeStrategy(buildOutsideOpts());
    const candidate: CandidateSession = {
      sessionAtomId: 'a' as AtomId,
      resumableSessionId: 'uuid-prep-001',
      startedAt: new Date().toISOString(),
      extra: { session_file_blob_ref: ref, cli_version: '2.0.0' },
      adapterId: 'claude-code-agent-loop',
    };
    const r = await s.findResumableSession({
      candidateSessions: [candidate],
      workspace: ws,
      host: stubHost,
    });
    expect(r).not.toBeNull();
    expect(r!.preparation).toBeDefined();
    await r!.preparation!();

    const expectedFile = join(homeOverride, '.claude', 'projects', expectedSlug, 'uuid-prep-001.jsonl');
    expect(existsSync(expectedFile)).toBe(true);
    expect(readFileSync(expectedFile)).toEqual(sessionBytes);
    if (process.platform !== 'win32') {
      // On POSIX, mode bits are enforced. On Windows, fs.chmod is best-effort.
      const stat = statSync(expectedFile);
      // mask off file-type bits; check user rwx + no group/other access (0600).
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('preparation closure derives slug from cwd by stripping leading separators and replacing remaining', async () => {
    const sessionBytes = Buffer.from('test\n', 'utf8');
    const ref = await outsideGitBs.put(sessionBytes);
    const s = new BlobShippedSessionResumeStrategy(buildOutsideOpts());
    // cwd with multiple path separators -- slug must replace all of them.
    const ws = { id: 'ws-1', path: '/a/b/c/d', baseRef: 'main' } as Workspace;
    const candidate: CandidateSession = {
      sessionAtomId: 'a' as AtomId,
      resumableSessionId: 'uuid-slug-001',
      startedAt: new Date().toISOString(),
      extra: { session_file_blob_ref: ref, cli_version: '2.0.0' },
      adapterId: 'claude-code-agent-loop',
    };
    const r = await s.findResumableSession({
      candidateSessions: [candidate],
      workspace: ws,
      host: stubHost,
    });
    await r!.preparation!();
    const expectedFile = join(homeOverride, '.claude', 'projects', 'a-b-c-d', 'uuid-slug-001.jsonl');
    expect(existsSync(expectedFile)).toBe(true);
  });

  it('skips candidate older than maxStaleHours', async () => {
    const sessionBytes = Buffer.from('test\n', 'utf8');
    const ref = await outsideGitBs.put(sessionBytes);
    const s = new BlobShippedSessionResumeStrategy(buildOutsideOpts({ maxStaleHours: 1 }));
    const tenHoursAgo = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
    const c: CandidateSession = {
      sessionAtomId: 'old' as AtomId,
      resumableSessionId: 'old-uuid',
      startedAt: tenHoursAgo,
      extra: { session_file_blob_ref: ref, cli_version: '2.0.0' },
      adapterId: 'claude-code-agent-loop',
    };
    expect(await s.findResumableSession({
      candidateSessions: [c],
      workspace: stubWs,
      host: stubHost,
    })).toBeNull();
  });
});

describe('BlobShippedSessionResumeStrategy -- onSessionPersist', () => {
  it('reads .jsonl, redacts, puts via blobStore, returns extras with blob ref + cli_version + captured_at', async () => {
    // Seed the source .jsonl with a payload that the tunedRedactor will transform.
    const cwd = '/p1';
    const slug = 'p1';
    const projDir = join(homeOverride, '.claude', 'projects', slug);
    mkdirSync(projDir, { recursive: true });
    const sessionFile = join(projDir, 'uuid-cap-001.jsonl');
    const ghTokenSecret = 'ghp_' + 'A'.repeat(36);
    writeFileSync(sessionFile, `{"line":"1","secret":"${ghTokenSecret}"}\n`, 'utf8');

    const s = new BlobShippedSessionResumeStrategy(buildOutsideOpts({ cliVersion: '2.5.0' }));
    const ws = { id: 'ws-1', path: cwd, baseRef: 'main' } as Workspace;
    const result = await s.onSessionPersist!({
      sessionId: 'uuid-cap-001',
      workspace: ws,
      host: stubHost,
    });
    // returned extras shape
    expect(typeof result['session_file_blob_ref']).toBe('string');
    expect((result['session_file_blob_ref'] as string).startsWith('sha256:')).toBe(true);
    expect(result['cli_version']).toBe('2.5.0');
    expect(typeof result['captured_at']).toBe('string');
    // captured_at is a valid ISO timestamp
    expect(() => new Date(result['captured_at'] as string).toISOString()).not.toThrow();

    // Verify redaction took effect: the stored blob does NOT contain the raw token.
    const storedBytes = await outsideGitBs.get(result['session_file_blob_ref'] as BlobRef);
    const stored = storedBytes.toString('utf8');
    expect(stored).not.toContain(ghTokenSecret);
    expect(stored).toContain('[REDACTED:gh-pat]');
  });

  it('returns {} when .jsonl is absent (capture fails open)', async () => {
    const s = new BlobShippedSessionResumeStrategy(buildOutsideOpts());
    const ws = { id: 'ws-1', path: '/nowhere', baseRef: 'main' } as Workspace;
    const result = await s.onSessionPersist!({
      sessionId: 'no-such-session',
      workspace: ws,
      host: stubHost,
    });
    expect(result).toEqual({});
  });

  it('applies redactor BEFORE blobStore.put (ordering)', async () => {
    const cwd = '/p2';
    const slug = 'p2';
    const projDir = join(homeOverride, '.claude', 'projects', slug);
    mkdirSync(projDir, { recursive: true });
    const sessionFile = join(projDir, 'uuid-ord-001.jsonl');
    const raw = 'beforeRedaction';
    writeFileSync(sessionFile, raw, 'utf8');

    const seenByRedactor: string[] = [];
    const seenByPut: Array<Buffer | string> = [];
    const recordingRedactor: Redactor = {
      redact: (content: string, _ctx: RedactContext) => {
        seenByRedactor.push(content);
        // Tunable response: must transform input so the constructor's
        // identity probe does not reject. Append a sentinel.
        return content + '__POST_REDACTION';
      },
    };
    const recordingBs: BlobStore = {
      async put(content: Buffer | string): Promise<BlobRef> {
        seenByPut.push(content);
        return 'sha256:' + 'b'.repeat(64) as BlobRef;
      },
      async get(): Promise<Buffer> {
        throw new Error('not used');
      },
      async has(): Promise<boolean> {
        return false;
      },
      describeStorage(): BlobStorageDescriptor {
        return { kind: 'remote', target: 'recorder' };
      },
    };
    // Suppress the INFO log from the remote-target guard.
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const s = new BlobShippedSessionResumeStrategy({
        acknowledgeSessionDataFlow: true,
        redactor: recordingRedactor,
        blobStore: recordingBs,
        cliVersion: '2.0.0',
        homeDirOverride: homeOverride,
      });
      // Reset recording to ignore the construction-time identity probe so
      // we observe ONLY the onSessionPersist call below.
      seenByRedactor.length = 0;
      seenByPut.length = 0;

      const ws = { id: 'ws-1', path: cwd, baseRef: 'main' } as Workspace;
      await s.onSessionPersist!({
        sessionId: 'uuid-ord-001',
        workspace: ws,
        host: stubHost,
      });
      // Redactor saw the raw bytes
      expect(seenByRedactor.length).toBe(1);
      expect(seenByRedactor[0]).toBe(raw);
      // BlobStore saw post-redaction bytes
      expect(seenByPut.length).toBe(1);
      const putContent = seenByPut[0];
      const putString = typeof putContent === 'string' ? putContent : (putContent as Buffer).toString('utf8');
      expect(putString).toBe(raw + '__POST_REDACTION');
    } finally {
      infoSpy.mockRestore();
    }
  });
});
