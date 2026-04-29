// Shared registry for the deep-planning pipeline's per-principal LLM
// tool policies and principal definitions.
//
// Extracted into a lib module (no shebang, no top-level side effects)
// so the test in test/runtime/planning-pipeline/principal-policies.test.ts
// can import the spec list and assert each entry round-trips through
// loadLlmToolPolicy without spawning a Node subprocess.
//
// The bootstrap script at scripts/bootstrap-llm-tool-policies.mjs imports
// PLANNING_PIPELINE_POLICIES + buildPolicyAtom + PLANNING_PIPELINE_PRINCIPALS
// from here. Mechanism (the data + atom builder) lives here; environment
// and host side effects stay in the script. Mirrors the inbox-canon-policies
// extraction pattern.
//
// All four principals carry the read-only posture (Read + Grep + Glob
// allowed, the eleven-tool deny-list blocked) per the deep-planning-
// pipeline spec section 6 and dev-actor-scoped-llm-tool-policy. Provenance
// chains to the seed operator-intent so the precursor is auditable.

const BOOTSTRAP_TIME = '2026-04-28T12:00:00.000Z';

const SOURCE_INTENT = 'operator-intent-deep-planning-pipeline-1777408799112';

/**
 * Canonical eleven-tool deny-list shared by every read-only principal in
 * the deep-planning pipeline. Mirrors the existing list in
 * scripts/bootstrap-llm-tool-policies.mjs (cto-actor + code-author share
 * the same shape) so a future single-source extraction can collapse all
 * three sites at once.
 *
 * Read, Grep, and Glob are deliberately omitted: planner / executor /
 * auditor postures are correctness-load-bearing on observed file state,
 * and a deny-all posture would force the LLM to draw plans from
 * imagination.
 */
export const READ_ONLY_DENY = Object.freeze([
  'Bash',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'TodoWrite',
  'SlashCommand',
]);

/**
 * Per-principal LLM tool-policy specs for the four pipeline principals.
 * Each entry produces a pol-llm-tool-policy-<principal-id> atom whose
 * metadata.policy carries READ_ONLY_DENY plus a principal-specific
 * rationale.
 */
export const PLANNING_PIPELINE_POLICIES = Object.freeze([
  {
    principalId: 'brainstorm-actor',
    rationale:
      'Brainstorm-stage planner posture: Read + Grep + Glob allowed so the '
      + 'first pipeline stage can survey alternatives grounded in canon and '
      + 'current code state. Writes denied because every brainstorm output '
      + 'lands as a framework-mediated atom write, not a subprocess tool '
      + 'call. Mirrors cto-actor planner posture for read-only research.',
  },
  {
    principalId: 'spec-author',
    rationale:
      'Spec-stage author posture: Read + Grep + Glob allowed so the prose '
      + 'spec and its cited paths can be verified against ground truth at '
      + 'draft time. Writes + Bash + Web* denied; the spec atom is the only '
      + 'authorized output and ships through the framework atom-write path.',
  },
  {
    principalId: 'pipeline-auditor',
    rationale:
      'Pipeline-auditor posture: Read + Grep + Glob allowed so cited path '
      + 'and atom-id verification walks ground truth. Writes denied because '
      + 'the auditor only emits pipeline-audit-finding atoms via the '
      + 'framework, never direct mutations. Compromise containment: the '
      + 'auditor cannot widen scope past Read+Grep+Glob, even if its prompt '
      + 'is taken over.',
  },
  {
    principalId: 'plan-dispatcher',
    rationale:
      'Plan-dispatcher posture: Read + Grep + Glob allowed so the dispatch '
      + 'stage can verify the upstream plan + spec + brainstorm chain '
      + 'before handing off to runDispatchTick. Writes denied because all '
      + 'dispatch mutations route through SubActorRegistry.invoke, not '
      + 'subprocess tool calls.',
  },
]);

/**
 * Per-principal principal-record specs for the four pipeline principals.
 * Each entry produces a Principal whose signed_by chain attaches to
 * claude-agent (matching cto-actor + code-author depth) so taint cascades
 * via the existing arbitration stack.
 */
export const PLANNING_PIPELINE_PRINCIPALS = Object.freeze([
  {
    id: 'brainstorm-actor',
    name: 'Brainstorm actor (deep-planning pipeline stage 1)',
    goals: [
      'Survey alternatives, surface open questions, and emit a brainstorm-notes '
        + 'atom for the next stage. Read-only research; no writes outside '
        + 'framework atom emission.',
    ],
    constraints: [
      'No L2/L3 writes. No merges. Read + Grep + Glob only; every other tool '
        + 'class is denied via pol-llm-tool-policy-brainstorm-actor.',
    ],
  },
  {
    id: 'spec-author',
    name: 'Spec author (deep-planning pipeline stage 2)',
    goals: [
      'Translate brainstorm-notes into a verified prose spec atom whose cited '
        + 'paths and atom-ids resolve against ground truth.',
    ],
    constraints: [
      'No L2/L3 writes. No merges. Cited paths must be verified before the '
        + 'spec atom persists.',
    ],
  },
  {
    id: 'pipeline-auditor',
    name: 'Pipeline auditor (deep-planning pipeline review stage)',
    goals: [
      'Walk every cited path and atom-id from the upstream plan; emit '
        + 'pipeline-audit-finding atoms with provenance; fail-closed when a '
        + 'citation cannot be verified.',
    ],
    constraints: [
      'No writes outside pipeline-audit-finding atoms. Per-file 64KB read cap; '
        + 'per-audit 1MB total read cap.',
    ],
  },
  {
    id: 'plan-dispatcher',
    name: 'Plan dispatcher (deep-planning pipeline dispatch stage)',
    goals: [
      'Hand off an audit-clean plan atom to runDispatchTick; never reimplement '
        + 'dispatch.',
    ],
    constraints: [
      'No writes outside the dispatch-record atom emitted by the runner. '
        + 'Default-deny when the upstream review-report is not all-clean.',
    ],
  },
]);

/**
 * Build a pol-llm-tool-policy-<principal-id> atom for one of the four
 * pipeline principals. Shape mirrors the existing cto-actor + code-author
 * policy atoms exactly (subject, principal, disallowed_tools, rationale)
 * so loadLlmToolPolicy resolves a non-null policy with the eleven-tool
 * deny-list.
 */
export function buildPolicyAtom(spec, operatorId) {
  if (!spec) throw new Error('buildPolicyAtom: spec is required');
  if (!operatorId) throw new Error('buildPolicyAtom: operatorId is required');
  return {
    schema_version: 1,
    id: `pol-llm-tool-policy-${spec.principalId}`,
    content:
      `LLM tool deny-list for principal "${spec.principalId}". `
      + `Blocks: ${READ_ONLY_DENY.join(', ')}. `
      + 'Read, Grep, and Glob are allowed by omission. '
      + spec.rationale,
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'bootstrap-llm-tool-policies', agent_id: 'bootstrap' },
      derived_from: [
        'dev-actor-scoped-llm-tool-policy',
        'inv-governance-before-autonomy',
        SOURCE_INTENT,
      ],
    },
    confidence: 1.0,
    created_at: BOOTSTRAP_TIME,
    last_reinforced_at: BOOTSTRAP_TIME,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: operatorId,
    taint: 'clean',
    metadata: {
      policy: {
        subject: 'llm-tool-policy',
        principal: spec.principalId,
        disallowed_tools: [...READ_ONLY_DENY],
        rationale: spec.rationale,
      },
    },
  };
}

/**
 * Build a Principal record for one of the four pipeline principals.
 * Shape mirrors the existing cto-actor principal: signed_by claude-agent,
 * agent role, project-scope writes, L0/L1 write only (cannot promote to
 * L3 directly per inv-l3-requires-human).
 */
export function buildPrincipal(spec, claudeAgentId) {
  if (!spec) throw new Error('buildPrincipal: spec is required');
  if (!claudeAgentId) throw new Error('buildPrincipal: claudeAgentId is required');
  return {
    id: spec.id,
    name: spec.name,
    role: 'agent',
    permitted_scopes: {
      read: ['session', 'project', 'user', 'global'],
      write: ['session', 'project'],
    },
    permitted_layers: {
      read: ['L0', 'L1', 'L2', 'L3'],
      write: ['L0', 'L1'],
    },
    goals: spec.goals,
    constraints: spec.constraints,
    active: true,
    compromised_at: null,
    signed_by: claudeAgentId,
    created_at: BOOTSTRAP_TIME,
  };
}
