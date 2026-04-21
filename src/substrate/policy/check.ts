/**
 * LAG policy primitive (Phase 52a).
 *
 * Canon-driven autonomy dial that layers ABOVE Claude Code's
 * permission-mode. A policy is an L3 canon atom carrying a standard
 * `metadata.policy` object. `checkToolPolicy(host, context)` matches
 * the active tool-use attempt against relevant policy atoms and
 * returns allow / deny / escalate.
 *
 * This is the seam that closes D13's trade-off: auto-mode is fine
 * for Stephen-at-terminal; risky for Stephen-on-phone. Instead of
 * making auto-mode itself stricter (which breaks the perpetual-
 * session ergonomic), we layer a canon rule on top that can say
 * "require HIL when a Bash call originates from Telegram".
 *
 * Policy atom shape (convention, not a new atom type):
 *   type: 'directive'
 *   layer: 'L3'
 *   metadata.policy: {
 *     subject: 'tool-use',
 *     tool: 'Bash' | 'Edit' | 'Write' | '*' | RegExp-string (pattern starts with ^)
 *     origin: 'telegram' | 'terminal' | 'wrapper' | 'daemon' | '*'
 *     principal: PrincipalId | '*'
 *     action: 'allow' | 'deny' | 'escalate'
 *     reason?: string        // human-readable explanation
 *     priority?: number       // higher wins on ties; default 0
 *   }
 *
 * Matching:
 *   - Candidate policies = L3 atoms with metadata.policy.subject = 'tool-use'.
 *   - A policy matches when its tool/origin/principal each match the
 *     context (literal equality, '*' wildcard, or ^regex).
 *   - Specificity score = (tool-match strength) + (origin-match strength)
 *     + (principal-match strength); exact > wildcard.
 *   - Highest specificity wins. Ties broken by metadata.policy.priority,
 *     then by atom.created_at desc (newer wins).
 *   - No match -> default allow (permissive substrate).
 */

import type { Host } from '../interface.js';
import type { Atom, AtomId, PrincipalId } from '../types.js';

export type PolicyDecision = 'allow' | 'deny' | 'escalate';

export interface PolicyContext {
  /** The tool the agent is about to call, e.g. 'Bash', 'Edit'. */
  readonly tool: string;
  /** Where the triggering prompt originated, e.g. 'telegram', 'terminal'. */
  readonly origin: string;
  /** Principal under whose authority the tool will run. */
  readonly principal: PrincipalId;
  /** Optional additional metadata the policy may key on later. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface PolicyResult {
  readonly decision: PolicyDecision;
  readonly reason: string;
  /** The matched policy atom id, if any. */
  readonly matchedAtomId?: AtomId;
  /** Specificity score of the matched policy; 0 when default-allow. */
  readonly specificity: number;
}

interface ParsedPolicy {
  readonly atom: Atom;
  readonly subject: string;
  readonly tool: string;
  readonly origin: string;
  readonly principal: string;
  readonly action: PolicyDecision;
  readonly reason: string;
  readonly priority: number;
}

/**
 * Look up the effective tool-use policy for a given context and
 * return the decision. Pure read against the atom store; no mutation.
 */
export async function checkToolPolicy(
  host: Host,
  context: PolicyContext,
  options: { maxPolicies?: number; pageSize?: number } = {},
): Promise<PolicyResult> {
  // Paginate through ALL L3 atoms. Partial pagination would mean a
  // more-specific policy sitting beyond the first page could be silently
  // missed, producing an incorrect authorization decision (the exact
  // failure mode CodeRabbit flagged). The loop terminates on nextCursor
  // = null OR when maxPolicies is reached (defence against unbounded
  // atom stores).
  const max = options.maxPolicies ?? Number.POSITIVE_INFINITY;
  const pageSize = options.pageSize ?? 200;
  const policies: ParsedPolicy[] = [];
  let cursor: string | undefined = undefined;
  let totalSeen = 0;
  while (true) {
    const page = await host.atoms.query({ layer: ['L3'] }, pageSize, cursor);
    for (const atom of page.atoms) {
      totalSeen++;
      const parsed = parsePolicy(atom);
      if (parsed && parsed.subject === 'tool-use') {
        policies.push(parsed);
      }
      if (totalSeen >= max) break;
    }
    if (totalSeen >= max) break;
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  if (policies.length === 0) {
    return {
      decision: 'allow',
      reason: 'No tool-use policies in canon; default-allow.',
      specificity: 0,
    };
  }

  let best: { policy: ParsedPolicy; specificity: number } | null = null;
  for (const p of policies) {
    const s = matchSpecificity(p, context);
    if (s === null) continue;
    if (best === null) {
      best = { policy: p, specificity: s };
      continue;
    }
    // Higher specificity wins; tie-break by priority, then created_at desc.
    if (s > best.specificity) {
      best = { policy: p, specificity: s };
    } else if (s === best.specificity) {
      if (p.priority > best.policy.priority) {
        best = { policy: p, specificity: s };
      } else if (
        p.priority === best.policy.priority
        && p.atom.created_at > best.policy.atom.created_at
      ) {
        best = { policy: p, specificity: s };
      }
    }
  }

  if (best === null) {
    return {
      decision: 'allow',
      reason: `No policy matched context (tool=${context.tool}, origin=${context.origin}, principal=${String(context.principal)}); default-allow.`,
      specificity: 0,
    };
  }
  return {
    decision: best.policy.action,
    reason: best.policy.reason,
    matchedAtomId: best.policy.atom.id,
    specificity: best.specificity,
  };
}

/**
 * Pure helper: extract a parsed policy from an atom. Returns null if
 * the atom does not carry a valid `metadata.policy` shape.
 */
export function parsePolicy(atom: Atom): ParsedPolicy | null {
  const policy = atom.metadata.policy;
  if (!policy || typeof policy !== 'object') return null;
  const p = policy as Record<string, unknown>;
  const subject = typeof p.subject === 'string' ? p.subject : null;
  const tool = typeof p.tool === 'string' ? p.tool : null;
  const origin = typeof p.origin === 'string' ? p.origin : '*';
  const principal = typeof p.principal === 'string' ? p.principal : '*';
  const action = typeof p.action === 'string' ? p.action : null;
  const reason = typeof p.reason === 'string'
    ? p.reason
    : `policy atom ${String(atom.id)}`;
  const priority = typeof p.priority === 'number' ? p.priority : 0;
  if (!subject || !tool || !action) return null;
  if (action !== 'allow' && action !== 'deny' && action !== 'escalate') return null;
  return { atom, subject, tool, origin, principal, action, reason, priority };
}

/**
 * Pure helper: score how specifically a policy matches a context.
 * Returns null when the policy does not match at all.
 *
 * Score breakdown (per field, summed):
 *   exact literal match : 4
 *   regex match (prefix '^'): 2
 *   wildcard '*'        : 1
 *   no match            : reject
 */
export function matchSpecificity(
  policy: ParsedPolicy,
  context: PolicyContext,
): number | null {
  const toolScore = fieldScore(policy.tool, context.tool);
  if (toolScore === null) return null;
  const originScore = fieldScore(policy.origin, context.origin);
  if (originScore === null) return null;
  const principalScore = fieldScore(policy.principal, String(context.principal));
  if (principalScore === null) return null;
  return toolScore + originScore + principalScore;
}

function fieldScore(spec: string, value: string): number | null {
  if (spec === '*') return 1;
  if (spec === value) return 4;
  if (spec.startsWith('^')) {
    try {
      const re = new RegExp(spec);
      return re.test(value) ? 2 : null;
    } catch {
      return null;
    }
  }
  return null;
}
