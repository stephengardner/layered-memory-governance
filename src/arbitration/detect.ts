/**
 * Conflict detection.
 *
 * Pipeline:
 *   1. Deterministic short-circuit: identical content-hashes = same fact = no conflict.
 *   2. LLM judge: classify the pair as semantic / temporal / none.
 *
 * The LLM judge operates in sandboxed mode. Atom content is rendered as
 * DATA never as prompt. Schema is enforced.
 */

import type { Host } from '../substrate/interface.js';
import { DETECT_CONFLICT } from '../schemas/index.js';
import type { Atom } from '../substrate/types.js';
import type { ConflictKind, ConflictPair } from './types.js';

// Re-export for backward compatibility with prior call sites.
// New code should import directly from '../schemas/index.js'.
export const DETECT_SCHEMA = DETECT_CONFLICT.jsonSchema;
export const DETECT_SYSTEM = DETECT_CONFLICT.systemPrompt;

export interface DetectOptions {
  readonly model?: string;
  readonly maxBudgetUsd?: number;
}

const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_BUDGET = 0.02;

export async function detectConflict(
  a: Atom,
  b: Atom,
  host: Host,
  options: DetectOptions = {},
): Promise<ConflictPair> {
  // Shortcut 1: identical content hash => reinforcement, not conflict.
  if (host.atoms.contentHash(a.content) === host.atoms.contentHash(b.content)) {
    return {
      a,
      b,
      kind: 'none',
      explanation: 'content hashes match (same fact, reinforcement)',
    };
  }

  const result = await host.llm.judge<{ kind: ConflictKind; explanation: string }>(
    DETECT_SCHEMA,
    DETECT_SYSTEM,
    {
      atom_a: {
        content: a.content,
        type: a.type,
        layer: a.layer,
        created_at: a.created_at,
      },
      atom_b: {
        content: b.content,
        type: b.type,
        layer: b.layer,
        created_at: b.created_at,
      },
    },
    {
      model: options.model ?? DEFAULT_MODEL,
      max_budget_usd: options.maxBudgetUsd ?? DEFAULT_BUDGET,
      temperature: 0,
    },
  );

  return {
    a,
    b,
    kind: result.output.kind,
    explanation: result.output.explanation,
  };
}
