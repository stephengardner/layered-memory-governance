/**
 * Adapter-specific failure classifier. Beats `defaultClassifyFailure`
 * by inspecting Claude CLI stderr shapes. Precedence is top-down:
 * the FIRST matching branch wins.
 */

import { defaultClassifyFailure } from '../../../src/substrate/agent-loop.js';
import type { FailureKind } from '../../../src/substrate/types.js';

export function classifyClaudeCliFailure(
  err: unknown,
  exitCode: number | null,
  stderr: string,
): FailureKind {
  if (err instanceof Error && err.name === 'AbortError') {
    return 'catastrophic';
  }
  if (/ENOENT|claude:\s*command not found/i.test(stderr)) {
    return 'catastrophic';
  }
  if (/\bauth\b|\b401\b|\b403\b/i.test(stderr)) {
    return 'catastrophic';
  }
  if (/\brate limit\b|\b429\b|\b50[234]\b|\bbad gateway\b|\bservice unavailable\b|\bgateway timeout\b|\bupstream\b/i.test(stderr)) {
    return 'transient';
  }
  if (exitCode !== null && exitCode !== 0) {
    return 'structural';
  }
  return defaultClassifyFailure(err);
}
