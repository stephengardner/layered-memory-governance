/**
 * Regression tests for .claude/hooks/enforce-claim-atom-writers.mjs.
 *
 * The hook intercepts AtomStore.put tool calls at PreToolUse time and
 * enforces that only the substrate principal (`apex-agent`) may write
 * claim-lifecycle atoms: `claim-attestation-accepted`,
 * `claim-attestation-rejected`, `claim-stalled`, `claim-escalated`.
 *
 * Sub-agent principals (cto-actor, code-author, pr-fix-actor,
 * cpo-actor, brainstorm-actor, plan-author, spec-author, and any
 * other non-apex principal) MUST be denied at write time so a routine
 * bypass attempt by a compromised or buggy sub-agent never produces a
 * forged attestation atom in the activity feed.
 *
 * The hook follows the standard Claude Code PreToolUse stdin/stdout
 * protocol shared with the other hooks in this directory: read a JSON
 * payload from stdin, emit either nothing (allow) or a JSON
 * `{"decision":"block","reason":"..."}` blob on stdout. The hook also
 * prints a clear diagnostic on stderr when it blocks so the bypass
 * attempt surfaces in the operator's session log even if the hook
 * runtime ever stops propagating reason text to the agent.
 *
 * Per spec Section 11 row 11, this hook is the primary gate against
 * the routine sub-agent bypass; in-process forgery from a compromised
 * contract module is a Tier 1 compromise outside this spec's threat
 * boundary (mitigated by STOP + medium-tier kill switch).
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HOOK_PATH = resolve('.claude/hooks/enforce-claim-atom-writers.mjs');

interface HookResult {
  readonly decision: 'block' | 'allow';
  readonly reason: string | null;
  readonly stderr: string;
  readonly exitCode: number;
}

async function runHook(payload: unknown): Promise<HookResult> {
  const child = spawn('node', [HOOK_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
  child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));

  const exitCode: number = await new Promise((res, rej) => {
    child.on('close', (code) => res(code ?? 0));
    child.on('error', rej);
  });

  const stderr = Buffer.concat(stderrChunks).toString('utf8');
  // The hook is documented as fail-open on parse errors and unexpected
  // input shapes (exit 0). A non-zero exit is only ever the BLOCK path
  // when stdout also carries the JSON decision; assert that pairing.
  const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
  if (stdout.length === 0) {
    return { decision: 'allow', reason: null, stderr, exitCode };
  }
  // Wrap JSON.parse in try/catch so a malformed stdout matches the
  // hook's documented fail-open contract: any parse failure surfaces
  // as an allow rather than crashing the harness with an SyntaxError
  // that masks the real test signal.
  let parsed: { decision?: string; reason?: string };
  try {
    parsed = JSON.parse(stdout) as { decision?: string; reason?: string };
  } catch {
    return { decision: 'allow', reason: null, stderr, exitCode };
  }
  return {
    decision: parsed.decision === 'block' ? 'block' : 'allow',
    reason: parsed.reason ?? null,
    stderr,
    exitCode,
  };
}

const CLAIM_LIFECYCLE_TYPES = [
  'claim-attestation-accepted',
  'claim-attestation-rejected',
  'claim-stalled',
  'claim-escalated',
] as const;

const SUB_AGENT_PRINCIPALS = [
  'cto-actor',
  'code-author',
  'pr-fix-actor',
  'cpo-actor',
  'brainstorm-actor',
] as const;

describe('enforce-claim-atom-writers hook (apex-agent allowed)', () => {
  for (const atomType of CLAIM_LIFECYCLE_TYPES) {
    it(`allows apex-agent to write ${atomType}`, async () => {
      const result = await runHook({
        tool_name: 'mcp__atomstore__put',
        tool_input: {
          atom: {
            id: 'atom-1',
            type: atomType,
            layer: 'L0',
            principal_id: 'apex-agent',
          },
        },
      });
      expect(result.decision).toBe('allow');
      expect(result.exitCode).toBe(0);
    });
  }
});

describe('enforce-claim-atom-writers hook (sub-agent principals denied)', () => {
  for (const principal of SUB_AGENT_PRINCIPALS) {
    for (const atomType of CLAIM_LIFECYCLE_TYPES) {
      it(`denies ${principal} writing ${atomType}`, async () => {
        const result = await runHook({
          tool_name: 'mcp__atomstore__put',
          tool_input: {
            atom: {
              id: 'atom-x',
              type: atomType,
              layer: 'L0',
              principal_id: principal,
            },
          },
        });
        expect(result.decision).toBe('block');
        expect(result.reason).toMatch(/claim-lifecycle/i);
        expect(result.reason).toContain(principal);
        expect(result.reason).toContain(atomType);
        // The diagnostic must also reach stderr so the bypass is visible
        // in the operator session log even when the agent suppresses
        // the JSON reason field.
        expect(result.stderr).toContain(principal);
        expect(result.stderr).toContain(atomType);
      });
    }
  }
});

describe('enforce-claim-atom-writers hook (passthrough)', () => {
  it('allows apex-agent writing a non-claim atom', async () => {
    const result = await runHook({
      tool_name: 'mcp__atomstore__put',
      tool_input: {
        atom: {
          id: 'plan-1',
          type: 'plan',
          layer: 'L0',
          principal_id: 'apex-agent',
        },
      },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows code-author writing a non-claim atom (e.g. plan)', async () => {
    const result = await runHook({
      tool_name: 'mcp__atomstore__put',
      tool_input: {
        atom: {
          id: 'plan-2',
          type: 'plan',
          layer: 'L0',
          principal_id: 'code-author',
        },
      },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows code-author writing an unrelated atom type (work-claim)', async () => {
    /*
     * work-claim atoms themselves are NOT in the claim-lifecycle
     * denial set; the substrate dispatch path mints them via the
     * apex principal anyway, but the hook does not gate them
     * because doing so would block legitimate read-paths that
     * never reach this hook in the first place.
     */
    const result = await runHook({
      tool_name: 'mcp__atomstore__put',
      tool_input: {
        atom: {
          id: 'wc-1',
          type: 'work-claim',
          layer: 'L0',
          principal_id: 'code-author',
        },
      },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows unrelated tools (Edit) without inspection', async () => {
    const result = await runHook({
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/x', old_string: 'a', new_string: 'b' },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows unrelated MCP tools (mcp__github__get_me) without inspection', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__get_me',
      tool_input: {},
    });
    expect(result.decision).toBe('allow');
  });

  it('allows Bash tool calls without inspection', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });
    expect(result.decision).toBe('allow');
  });
});

describe('enforce-claim-atom-writers hook (tool-name variants)', () => {
  /*
   * The substrate has not yet shipped an MCP atom-store tool, but the
   * spec leaves the seam open: the hook must recognise the canonical
   * `AtomStore.put` shape as well as the eventual MCP variant. Both
   * names target the same write path, so both must be inspected.
   */
  it('inspects `AtomStore.put` tool name (canonical in-process form)', async () => {
    const result = await runHook({
      tool_name: 'AtomStore.put',
      tool_input: {
        atom: {
          id: 'a',
          type: 'claim-stalled',
          layer: 'L0',
          principal_id: 'code-author',
        },
      },
    });
    expect(result.decision).toBe('block');
  });

  it('inspects `mcp__atomstore__put` tool name (future MCP form)', async () => {
    const result = await runHook({
      tool_name: 'mcp__atomstore__put',
      tool_input: {
        atom: {
          id: 'a',
          type: 'claim-escalated',
          layer: 'L0',
          principal_id: 'cto-actor',
        },
      },
    });
    expect(result.decision).toBe('block');
  });
});

describe('enforce-claim-atom-writers hook (malformed payloads fail open)', () => {
  it('fails open on malformed JSON payload', async () => {
    const child = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.write('not-json{{{');
    child.stdin.end();
    const exitCode: number = await new Promise((res, rej) => {
      child.on('close', (code) => res(code ?? 0));
      child.on('error', rej);
    });
    expect(exitCode).toBe(0);
  });

  it('allows missing tool_input', async () => {
    const result = await runHook({ tool_name: 'mcp__atomstore__put' });
    expect(result.decision).toBe('allow');
  });

  it('allows tool_input without atom', async () => {
    const result = await runHook({
      tool_name: 'mcp__atomstore__put',
      tool_input: { other: 'thing' },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows atom without a type', async () => {
    const result = await runHook({
      tool_name: 'mcp__atomstore__put',
      tool_input: { atom: { principal_id: 'code-author' } },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows atom without a principal_id (defensive; missing field is not a sub-agent bypass)', async () => {
    /*
     * If a payload reaches the hook with no principal_id, the call is
     * malformed and downstream validation will reject it; the hook
     * stays out of the way rather than risk false-positive blocks on
     * shape it cannot interpret. The substrate writer mints
     * principal_id deterministically, so any path reaching the hook
     * without one is not the bypass surface this hook guards.
     */
    const result = await runHook({
      tool_name: 'mcp__atomstore__put',
      tool_input: { atom: { type: 'claim-stalled' } },
    });
    expect(result.decision).toBe('allow');
  });
});
