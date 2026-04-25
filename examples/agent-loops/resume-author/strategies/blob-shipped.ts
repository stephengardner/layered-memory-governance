/**
 * BlobShippedSessionResumeStrategy: cross-machine session resume via a
 * content-addressed blob seam.
 *
 * Capture (`onSessionPersist`)
 * ----------------------------
 * Reads the local CLI session file, applies the operator-supplied redactor,
 * and ships the redacted bytes to the configured BlobStore. Returns extras
 * that the wrapper merges into the session atom's `extra` slot:
 *   - session_file_blob_ref (BlobRef returned by the put)
 *   - cli_version (pinned at construction)
 *   - captured_at (ISO timestamp at capture time)
 *
 * Rehydrate (`findResumableSession`)
 * ----------------------------------
 * On a candidate carrying the matching `cli_version` plus a
 * `session_file_blob_ref` in `extra`, returns a ResolvedSession whose
 * `preparation` closure fetches the blob and writes it back to the local
 * CLI cache (`<home>/.claude/projects/<slug>/<uuid>.jsonl`) with mode 0600.
 *
 * Construction-time guards (default-deny)
 * ---------------------------------------
 * Four guards run at construction; misconfiguration throws so the
 * misconfigured strategy can never be installed.
 *
 *   1. `acknowledgeSessionDataFlow` MUST be the literal `true`. The
 *      TypeScript type forces a positional opt-in; the runtime guard
 *      double-checks because callers can erase types at the seam (`as any`).
 *   2. `redactor` MUST be supplied (no default). An identity redactor is
 *      detected by feeding a known-secret-shape probe through the redactor
 *      synchronously and rejecting on verbatim return. The probe contains
 *      multiple secret patterns so any redactor "tuned for session content"
 *      will transform at least one. If the redactor throws on the probe,
 *      that is NOT identity behavior; we accept and let the redactor's
 *      first real call surface the error (per the substrate's loud-fail
 *      contract for redactors).
 *   3. `blobStore.describeStorage()` is inspected:
 *        - `local-file`: the resolved rootPath MUST not have any `.git/`
 *          directory in its ancestor chain. Walks up to the filesystem
 *          root looking for `.git/`; if found, throws with both paths
 *          named in the diagnostic.
 *        - `remote`: logs the target at INFO and proceeds. The framework
 *          does not validate remote authorization; the operator who
 *          chose a remote BlobStore is the locus of trust.
 *   4. `cliVersion` is pinned at construction. On `findResumableSession`,
 *      a candidate with `extra.cli_version !== cliVersion` is skipped
 *      (returns null on that candidate, walker continues).
 *
 * Slug derivation
 * ---------------
 * The CLI's project-slug-from-cwd convention (CLI v2.x, verify on each
 * --resume version bump): take absolute cwd, drop the leading separator,
 * replace remaining path separators with `-`. Examples:
 *   /Users/op/memory-governance       -> Users-op-memory-governance
 *   C:\Users\op\memory-governance     -> Users-op-memory-governance
 * The cliVersion pin is the safety net: if a CLI version changes the
 * convention, the captured blob's cli_version mismatches at rehydration
 * and the strategy returns null, falling through to fresh-spawn.
 */

import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import type {
  BlobStore,
  BlobRef,
} from '../../../../src/substrate/blob-store.js';
import type { Redactor } from '../../../../src/substrate/redactor.js';
import type { PrincipalId } from '../../../../src/substrate/types.js';
import type {
  SessionResumeStrategy,
  ResumeContext,
  ResolvedSession,
} from '../types.js';
import type { Workspace } from '../../../../src/substrate/workspace-provider.js';
import type { Host } from '../../../../src/substrate/interface.js';

const DEFAULT_MAX_STALE_HOURS = 8;
const HOUR_MS = 60 * 60 * 1000;
const ADAPTER_ID = 'claude-code-agent-loop';

/**
 * Multi-pattern probe for the identity-redactor guard. Combines a
 * github-PAT-shape, AWS-access-key-shape, and JWT-shape so a redactor
 * tuned for any of the common session-content secret kinds will
 * transform the probe; an identity redactor returns it verbatim and the
 * constructor rejects.
 *
 * If a redactor only covers patterns NOT represented here, the probe
 * passes through verbatim and we'd false-positive identity-reject. That
 * trade-off is intentional: the failure mode is "operator with an
 * incomplete redactor must add ONE of these common patterns to be
 * accepted by the strategy." The alternative (skip the identity check)
 * silently ships untransformed session content; the alternative (fewer
 * patterns) reduces the false-positive chance but also reduces detection
 * power. The chosen patterns are the most common third-party secret
 * formats that any reasonable session-content redactor would cover.
 */
const IDENTITY_PROBE =
  'GH-TOKEN-ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA AKIAIOSFODNN7EXAMPLE eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0In0.s5IWZJaWk-3rlSRaBBR4zJ9zAyVhJY6e';

const PROBE_PRINCIPAL = 'redactor-probe' as PrincipalId;

export interface BlobShippedStrategyOptions {
  readonly blobStore: BlobStore;
  /**
   * REQUIRED. No default. The redactor MUST be tuned for session content
   * (transcripts, tool args, tool results) per spec §5.2 threat model.
   * Identity redactors are rejected by the constructor's probe.
   */
  readonly redactor: Redactor;
  /**
   * REQUIRED. The CLI version that wrote the captured session file.
   * On rehydration, candidates whose `extra.cli_version` does not match
   * this string are skipped (return null on that candidate). The pin is
   * the safety gate for the slug-derivation convention; a CLI version
   * that changes the slug rule causes mismatch -> skip -> fall-through.
   */
  readonly cliVersion: string;
  /**
   * REQUIRED. MUST be the literal `true`. Default-deny construction per
   * spec §5.2: an operator who installs this strategy makes a deliberate,
   * named choice acknowledging the operator-trust-boundary crossing.
   */
  readonly acknowledgeSessionDataFlow: true;
  /** Default 8 hours. Candidates older than this are skipped. */
  readonly maxStaleHours?: number;
  /**
   * Test-only: override $HOME for resolving the local CLI cache path.
   * In production the strategy reads `os.homedir()`. Tests inject a
   * tmpdir so they never touch the real home directory.
   */
  readonly homeDirOverride?: string;
  /**
   * Test-only: override the filesystem probe used by the destination
   * guard. The default uses `node:fs.existsSync`. Tests on a developer
   * machine whose user directory is itself inside a git tree (which
   * would false-positive the guard) inject a controlled probe so the
   * test decides which paths look git-tracked. Production callers MUST
   * leave this undefined.
   */
  readonly _testFsExists?: (p: string) => boolean;
}

export class BlobShippedSessionResumeStrategy implements SessionResumeStrategy {
  readonly name = 'blob-shipped';
  private readonly opts: BlobShippedStrategyOptions;
  private readonly maxStaleMs: number;

  constructor(opts: BlobShippedStrategyOptions) {
    // Guard 1: explicit consent literal `true`.
    if (opts.acknowledgeSessionDataFlow !== true) {
      throw new Error(
        'BlobShippedSessionResumeStrategy: acknowledgeSessionDataFlow must be the literal `true` to consent to session-content data flow across the operator-trust boundary. See spec section 5.2 threat model.',
      );
    }

    // Guard 2 (sync): redactor present + identity rejected.
    if (opts.redactor === undefined || opts.redactor === null) {
      throw new Error(
        'BlobShippedSessionResumeStrategy: redactor is required (no default). Supply a Redactor explicitly tuned for session content. See spec section 5.2.',
      );
    }
    // Identity probe runs at construction time. The substrate Redactor
    // contract is synchronous (`redact(content, ctx): string`); a sync
    // probe is sufficient and stronger than a deferred one. A throw is
    // accepted: a redactor that throws on the probe is loud-failing per
    // its contract; it will throw on real content too. We only reject
    // verbatim returns (the identity behavior).
    let probed: string | undefined;
    try {
      probed = opts.redactor.redact(IDENTITY_PROBE, {
        kind: 'tool-result',
        principal: PROBE_PRINCIPAL,
      });
    } catch {
      // Throwing redactor is not identity. Accept; first real call will
      // re-throw the same error.
      probed = undefined;
    }
    if (probed === IDENTITY_PROBE) {
      throw new Error(
        'BlobShippedSessionResumeStrategy: redactor appears to be identity (returned a known-secret-shape probe verbatim). Identity redactor is rejected; tune the redactor for session content per spec section 5.2.',
      );
    }

    // CLI-version pin.
    if (typeof opts.cliVersion !== 'string' || opts.cliVersion.length === 0) {
      throw new Error(
        'BlobShippedSessionResumeStrategy: cliVersion is required at construction (non-empty string). Pin to the version of the CLI that produced the session file. See spec section 3.6.',
      );
    }

    // Guard 3: BlobStore destination.
    const desc = opts.blobStore.describeStorage();
    const fsExists = opts._testFsExists ?? fsSync.existsSync;
    if (desc.kind === 'local-file') {
      const resolvedRoot = path.resolve(desc.rootPath);
      let dir = resolvedRoot;
      // Walk up looking for any `.git/` ancestor.
      // Termination: parent === dir at filesystem root.
      // The walk-up MUST run before any other operation can be invoked
      // on the strategy; misconfiguration MUST be a construction-time
      // failure, not a runtime surprise.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const dotGit = path.join(dir, '.git');
        if (fsExists(dotGit)) {
          throw new Error(
            `BlobShippedSessionResumeStrategy: blobStore rootPath '${desc.rootPath}' resolves inside git-tracked tree at '${dotGit}'. Session-content blobs MUST NOT flow into git-tracked storage. Use a BlobStore rooted outside any git tree, or wire a remote BlobStore with operator-controlled trust review per spec section 5.2.`,
          );
        }
        const parent = path.dirname(dir);
        if (parent === dir) break; // reached filesystem root
        dir = parent;
      }
    } else if (desc.kind === 'remote') {
      // Trust transfer to operator. Log INFO at construction so it is
      // visible in operator logs without blocking the construction.
      console.info(
        `[BlobShippedSessionResumeStrategy] BlobStore destination is remote: ${desc.target}. Operator-controlled trust review required per spec section 5.2.`,
      );
    }

    this.opts = opts;
    this.maxStaleMs = (opts.maxStaleHours ?? DEFAULT_MAX_STALE_HOURS) * HOUR_MS;
  }

  async findResumableSession(ctx: ResumeContext): Promise<ResolvedSession | null> {
    const compatible = ctx.candidateSessions.filter((s) => s.adapterId === ADAPTER_ID);
    for (const candidate of compatible) {
      const startedAtMs = new Date(candidate.startedAt).getTime();
      if (Number.isNaN(startedAtMs)) continue;
      if (Date.now() - startedAtMs >= this.maxStaleMs) continue;

      const blobRef = candidate.extra['session_file_blob_ref'];
      const capturedVersion = candidate.extra['cli_version'];
      if (typeof blobRef !== 'string' || blobRef.length === 0) continue;
      // CLI-version mismatch = skip (do not throw). Falls through to
      // next strategy or fresh-spawn.
      if (capturedVersion !== this.opts.cliVersion) continue;

      // Capture references for the closure so opts shape is stable.
      const blobStore = this.opts.blobStore;
      const homeDirOverride = this.opts.homeDirOverride;
      const cwd = ctx.workspace.path;
      const resumableSessionId = candidate.resumableSessionId;

      return {
        resumableSessionId,
        resumedFromSessionAtomId: candidate.sessionAtomId,
        strategyName: this.name,
        preparation: async () => {
          const bytes = await blobStore.get(blobRef as BlobRef);
          const home = homeDirOverride ?? homedir();
          const slug = derivePosixSlugFromCwd(cwd);
          const targetDir = path.join(home, '.claude', 'projects', slug);
          const targetFile = path.join(targetDir, `${resumableSessionId}.jsonl`);
          // Parent dir mode 0700; file mode 0600 enforced even on
          // overwrite. `fs.writeFile(..., { mode })` only honors `mode`
          // at file CREATE time; on a second fix-run against the same
          // resumable session the existing file's mode (potentially
          // 0644 from a stale write or umask) would survive. Explicit
          // `unlink` + `chmod` belt-and-suspenders ensures the locked-
          // down perms claim of this strategy is real on every run.
          await fs.mkdir(targetDir, { recursive: true, mode: 0o700 });
          await fs.rm(targetFile, { force: true });
          await fs.writeFile(targetFile, bytes, { mode: 0o600 });
          await fs.chmod(targetFile, 0o600);
        },
      };
    }
    return null;
  }

  async onSessionPersist(input: {
    readonly sessionId: string;
    readonly workspace: Workspace;
    readonly host: Host;
    readonly principal: PrincipalId;
  }): Promise<Readonly<Record<string, unknown>>> {
    const cwd = input.workspace.path;
    const home = this.opts.homeDirOverride ?? homedir();
    const slug = derivePosixSlugFromCwd(cwd);
    const sourceFile = path.join(home, '.claude', 'projects', slug, `${input.sessionId}.jsonl`);
    let raw: string;
    try {
      raw = await fs.readFile(sourceFile, 'utf8');
    } catch {
      // Capture fails open: missing/unreadable session file leaves no
      // extras on the atom; same-machine strategy still works for the
      // operator's local fix-runs. Spec section 3.6.
      return {};
    }
    // Apply redactor BEFORE BlobStore.put. Spec section 5.2 + threat-model
    // ordering: untransformed bytes MUST NOT touch the BlobStore.
    //
    // Pass the session's owning principal (NOT the constructor-time
    // PROBE_PRINCIPAL sentinel). Audit logs, per-principal redactor
    // allowlists, and tenant-scoped rules all branch on `ctx.principal`;
    // a sentinel leak would misattribute every real capture to the
    // probe identity.
    const redacted = this.opts.redactor.redact(raw, {
      kind: 'tool-result',
      principal: input.principal,
    });
    const ref = await this.opts.blobStore.put(redacted);
    return {
      session_file_blob_ref: ref,
      cli_version: this.opts.cliVersion,
      captured_at: new Date().toISOString(),
    };
  }
}

/**
 * Derive the CLI's project slug from a cwd path. Convention (CLI v2.x):
 *   - Strip Windows drive prefix (e.g. `C:`).
 *   - Drop leading separator(s).
 *   - Replace remaining path separators with `-`.
 *
 * The strategy's cliVersion pin is the safety net: a CLI version where
 * this convention changes will cause `findResumableSession` to return
 * null on the cli_version mismatch, falling through to fresh-spawn.
 */
function derivePosixSlugFromCwd(cwd: string): string {
  // Strip Windows drive letter prefix ("C:", "D:", etc.).
  let p = cwd.replace(/^[a-zA-Z]:/, '');
  // Drop any number of leading path separators.
  p = p.replace(/^[\\/]+/, '');
  // Replace remaining path separators with `-`.
  return p.replace(/[\\/]+/g, '-');
}
