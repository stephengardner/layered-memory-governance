/**
 * Tests for the claim_secret_token redactor pattern.
 *
 * Spec Section 11 trade-off
 * -------------------------
 * The standalone 43+ char base64url pattern false-positives on
 * - SHA-256 hashes (64 hex chars, all match [A-Za-z0-9])
 * - JWT signatures (the third base64url segment)
 * - git commit SHAs encoded in certain forms
 *
 * Accepted: a leaked token enables a sub-agent impersonation attack
 * that is unrecoverable; over-redacting a legitimate string is
 * recoverable (debug-time inconvenience). The redactor errs toward
 * safety. The agent-turn atom helper is the primary integration
 * point because LLM input/output is where the operator's token-bearing
 * RECOVERY UPDATE preamble lands.
 */

import { describe, expect, it } from 'vitest';
import {
  redactDefault,
  redactAgentTurnAtom,
  CLAIM_SECRET_TOKEN_PATTERN,
} from '../../../examples/redactors/regex-default/patterns.js';

describe('CLAIM_SECRET_TOKEN_PATTERN', () => {
  it('strips labeled tokens (claim_secret_token: ...)', () => {
    const token = 'A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0U1V';
    const input = `before claim_secret_token: ${token} after`;
    const out = redactDefault(input);
    expect(out).toContain('[REDACTED:CLAIM_TOKEN]');
    expect(out).not.toContain(token);
  });

  it('strips standalone 43+ char base64url strings', () => {
    const token = 'A'.repeat(43);
    const out = redactDefault(`stray ${token} loose`);
    expect(out).toContain('[REDACTED:CLAIM_TOKEN]');
    expect(out).not.toContain(token);
  });

  it('does not redact base64url-shape strings shorter than 43 chars', () => {
    const short = 'A'.repeat(42);
    expect(redactDefault(short)).toBe(short);
  });

  it('strips a base64url token starting with `-`', () => {
    // Base64url alphabet legally includes `-`, which is NOT a regex
    // word char. A naive \b-anchored pattern would miss tokens whose
    // first character is `-`; the alphabet-based lookbehind catches them.
    const token = '-' + 'A'.repeat(42);
    const out = redactDefault(`stray ${token} loose`);
    expect(out).toContain('[REDACTED:CLAIM_TOKEN]');
    expect(out).not.toContain(token);
  });

  it('strips a base64url token ending with `-`', () => {
    const token = 'A'.repeat(42) + '-';
    const out = redactDefault(`stray ${token} loose`);
    expect(out).toContain('[REDACTED:CLAIM_TOKEN]');
    expect(out).not.toContain(token);
  });

  it('strips a base64url token starting and ending with `-`', () => {
    const token = '-' + 'A'.repeat(41) + '-';
    const out = redactDefault(`stray ${token} loose`);
    expect(out).toContain('[REDACTED:CLAIM_TOKEN]');
    expect(out).not.toContain(token);
  });

  it('strips token from agent-turn atom llm_input / llm_output / tool_calls (canonical inline shape)', () => {
    // Canonical AgentTurnMeta uses discriminated-union shapes for
    // llm_input / llm_output / tool_calls.args / tool_calls.result:
    // `{ inline: string } | { ref: BlobRef }`. tool_calls entries also
    // carry `tool`, `latency_ms`, `outcome`. The redactor MUST handle
    // both shapes; this test exercises the inline branch.
    const token = 'B'.repeat(43);
    const atom = {
      type: 'agent-turn',
      metadata: {
        agent_turn: {
          llm_input: { inline: `here is the token ${token}` },
          llm_output: { inline: `received claim_secret_token: ${token}` },
          tool_calls: [
            {
              tool: 'echo',
              args: { inline: token },
              result: { inline: 'ok' },
              latency_ms: 42,
              outcome: 'success',
            },
          ],
        },
      },
    };
    const redacted = redactAgentTurnAtom(atom);
    expect(JSON.stringify(redacted.metadata.agent_turn.llm_input)).not.toContain(token);
    expect(JSON.stringify(redacted.metadata.agent_turn.llm_output)).not.toContain(token);
    expect(JSON.stringify(redacted.metadata.agent_turn.tool_calls)).not.toContain(token);
  });

  it('documents the false-positive trade: SHA-256 hex (64 chars) is redacted', () => {
    // 64 hex chars satisfies [A-Za-z0-9_-]{43,}. Accepted per spec Section 11.
    const sha256 = 'a'.repeat(64);
    expect(redactDefault(sha256)).toContain('[REDACTED:CLAIM_TOKEN]');
  });

  it('is idempotent: redacting an already-redacted string is a no-op', () => {
    const token = 'C'.repeat(43);
    const once = redactDefault(`claim_secret_token: ${token}`);
    const twice = redactDefault(once);
    expect(twice).toBe(once);
  });

  it('redacts multi-occurrence tokens (every match, not just first)', () => {
    const token = 'D'.repeat(43);
    const out = redactDefault(`first ${token} second ${token} third`);
    expect(out).not.toContain(token);
    // Both occurrences redacted -> at least two markers present.
    const markerCount = (out.match(/\[REDACTED:CLAIM_TOKEN\]/g) ?? []).length;
    expect(markerCount).toBeGreaterThanOrEqual(2);
  });

  it('handles mixed inline + ref discriminated-union shapes on agent-turn atoms', () => {
    // Canonical AgentTurnMeta uses `{ inline: string } | { ref: BlobRef }`
    // for llm_input / llm_output / tool_calls.args / tool_calls.result.
    // tool_calls entries also carry `tool`, `latency_ms`, `outcome` per
    // AgentTurnMeta (src/substrate/types.ts). The helper must redact
    // every inline payload while leaving ref-shaped slots untouched.
    const token = 'E'.repeat(43);
    const atom = {
      type: 'agent-turn',
      metadata: {
        agent_turn: {
          llm_input: { inline: `token ${token}` },
          llm_output: { ref: { blob_id: 'b-xyz' } },
          tool_calls: [
            {
              tool: 'echo',
              args: { inline: token },
              result: { ref: { blob_id: 'b-r' } },
              latency_ms: 17,
              outcome: 'success',
            },
          ],
        },
      },
    };
    const redacted = redactAgentTurnAtom(atom);
    const turn = redacted.metadata.agent_turn;
    expect(JSON.stringify(turn.llm_input)).not.toContain(token);
    // ref-shaped slots are passed through unchanged (no inline payload to scan)
    expect(turn.llm_output).toEqual({ ref: { blob_id: 'b-xyz' } });
    expect(JSON.stringify(turn.tool_calls)).not.toContain(token);
  });

  it('exposes CLAIM_SECRET_TOKEN_PATTERN as a RedactionPattern entry', () => {
    expect(CLAIM_SECRET_TOKEN_PATTERN.name).toBe('claim-secret-token');
    expect(CLAIM_SECRET_TOKEN_PATTERN.replacement).toBe('[REDACTED:CLAIM_TOKEN]');
    expect(CLAIM_SECRET_TOKEN_PATTERN.pattern.flags).toContain('g');
  });

  it('is included in DEFAULT_PATTERNS so a fresh RegexRedactor sees it', async () => {
    // Reuse the existing reference adapter to confirm wiring.
    const { RegexRedactor } = await import('../../../examples/redactors/regex-default/index.js');
    const r = new RegexRedactor();
    const token = 'F'.repeat(43);
    const out = r.redact(`claim_secret_token: ${token}`, {
      kind: 'tool-result' as const,
      principal: 'p' as never,
    });
    expect(out).toContain('[REDACTED:CLAIM_TOKEN]');
    expect(out).not.toContain(token);
  });
});
