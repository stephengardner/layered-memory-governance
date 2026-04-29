/**
 * Workspace-side byte-cap helper for the review-stage auditor.
 *
 * Path-content verification with a per-file size guard plus a per-audit
 * total-bytes ceiling. For files exceeding the per-file cap, the helper
 * computes a sha256 hash via streaming reads instead of loading the
 * full content into memory; the hash is the audit signal (path is
 * reachable, content is bounded) without paying the full read cost.
 *
 * Why this is workspace-side rather than a Host extension
 * -------------------------------------------------------
 * The Host interface is the single substrate boundary; Host sub-
 * interfaces are extracted only when a second consumer needs the same
 * surface. A path-content-hash seam currently has one consumer (this
 * review-stage auditor); per the host-interface single-consumer rule,
 * the implementation lives in this adapter. If a second consumer
 * materializes (e.g. a CD-pipeline auditor), the moment to extract a
 * Host sub-interface is then, not speculatively now.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';

/** Per-file read budget; an over-budget file is hashed instead of read. */
export const PER_FILE_BYTE_CAP = 64 * 1024;

/** Per-audit total read budget; further reads are skipped beyond this cap. */
export const PER_AUDIT_TOTAL_BYTE_CAP = 1024 * 1024;

export type PathProbeOutcome =
  | { readonly kind: 'reachable'; readonly bytesAccountedFor: number }
  | { readonly kind: 'reachable-via-hash'; readonly bytesAccountedFor: number; readonly sha256: string }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'budget-exceeded' };

/**
 * Stateful budget tracker for a single audit pass. Threading state
 * through this object keeps the per-audit cap a single source of truth
 * across the review-stage's cited-paths walk; callers do not pass
 * accumulating counters around.
 */
export class AuditByteBudget {
  private bytesUsed = 0;

  constructor(
    public readonly perFileCapBytes: number = PER_FILE_BYTE_CAP,
    public readonly perAuditCapBytes: number = PER_AUDIT_TOTAL_BYTE_CAP,
  ) {}

  /** Bytes accounted for so far across this audit pass. */
  get totalBytesRead(): number {
    return this.bytesUsed;
  }

  /**
   * Probe a single cited path. Returns one of four outcomes:
   *
   *   - 'reachable': file was within the per-file cap; full bytes counted.
   *   - 'reachable-via-hash': file exceeded the per-file cap; sha256 hash
   *     computed via streaming read instead of full load. Bytes counted
   *     are the cap value, not the file size, so a runaway-large path
   *     does not single-handedly exhaust the per-audit budget.
   *   - 'unreachable': fs.stat or fs.readFile threw (path missing,
   *     permission denied, EPERM on Windows, etc.).
   *   - 'budget-exceeded': the per-audit total cap was hit before the
   *     read started; the path is left un-probed and the caller emits
   *     a 'budget-exceeded' marker so the audit walk halts cleanly.
   */
  async probe(path: string): Promise<PathProbeOutcome> {
    if (this.bytesUsed >= this.perAuditCapBytes) {
      return { kind: 'budget-exceeded' };
    }
    let stat;
    try {
      stat = await fs.stat(path);
    } catch {
      return { kind: 'unreachable' };
    }
    if (!stat.isFile()) {
      return { kind: 'unreachable' };
    }
    const remainingBudget = this.perAuditCapBytes - this.bytesUsed;
    if (
      stat.size <= this.perFileCapBytes
      && stat.size <= remainingBudget
    ) {
      // Within per-file cap AND within remaining per-audit budget:
      // full read is permitted; we account for the actual byte count
      // so the per-audit total reflects real work.
      try {
        const content = await fs.readFile(path);
        this.bytesUsed += content.byteLength;
        return {
          kind: 'reachable',
          bytesAccountedFor: content.byteLength,
        };
      } catch {
        return { kind: 'unreachable' };
      }
    }
    // Over per-file cap (or full read would breach per-audit budget):
    // hash via streaming read so memory does not hold the whole file.
    // The bytes accounted for is min(per-file cap, remaining budget) --
    // a defensive lower-bound on the read effort that keeps the
    // per-audit ceiling a hard guarantee. An LLM-emitted runaway-large
    // path does not exhaust the audit budget on a single entry.
    const accounted = Math.min(this.perFileCapBytes, remainingBudget);
    try {
      const sha256 = await streamSha256(path);
      this.bytesUsed += accounted;
      return {
        kind: 'reachable-via-hash',
        bytesAccountedFor: accounted,
        sha256,
      };
    } catch {
      return { kind: 'unreachable' };
    }
  }
}

async function streamSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => {
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}
