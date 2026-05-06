/**
 * Principal classifier for the PrincipalSkill empty-state surface.
 *
 * The console renders a SKILL.md panel for every principal it surfaces.
 * Principals divide into four semantically distinct cases that share
 * the empty-state shape but DO NOT share the empty-state reason:
 *
 *   - authority-root: role==='apex'. The authority root (apex-agent
 *     in this repo) does not own a playbook by design; it is the
 *     trust anchor, not an executor.
 *
 *   - authority-anchor: role==='agent' AND signs at least one other
 *     principal. The anchor (claude-agent in this repo) is a meta /
 *     trust-relay principal whose children are the actors with
 *     playbooks. The anchor itself does not own a playbook by design.
 *
 *   - actor-with-skill: a leaf actor whose .claude/skills/<id>/SKILL.md
 *     resolves. The empty-state branch does not run; the union stays
 *     total so the consumer can narrow exhaustively.
 *
 *   - actor-skill-debt: any other principal. A leaf actor that should
 *     have a playbook but does not. This is the only case that
 *     represents authoring debt.
 *
 * Design rationale (substrate-deep deliberation atoms):
 *   - intent-40b633b9df21-2026-05-05T22-19-56-119Z (operator intent)
 *   - spec-output-pipeline-cto-1778019756892-6nyq47-spec-stage-...
 *   - plan-differentiate-lag-console-principal-skil-...
 *   - review-report-pipeline-cto-1778019756892-6nyq47-review-stage-...
 *
 * Placement: under apps/console/server/ rather than src/ because the
 * framework layer stays mechanism-only per the operator intent. The
 * classifier is instance policy, not framework primitive.
 *
 * Input shape: a narrow projection { role, signedBy, hasChildren,
 * hasSkill } rather than a full principal record. Decoupling the
 * classifier signature from record evolution keeps fixtures tight
 * and reflects the actual dependency surface (4 fields, not 13).
 */

/** The classification outcome. Discriminated by `kind`. */
export type PrincipalCategory =
  | 'authority-root'
  | 'authority-anchor'
  | 'actor-with-skill'
  | 'actor-skill-debt';

/**
 * Inputs the classifier needs to decide. Hand-assembled at the call
 * site (see server/index.ts handlePrincipalSkill) from a principal
 * record plus the principal-graph and a filesystem stat.
 */
export interface PrincipalClassifierInput {
  /**
   * The principal's role string (apex/agent/human/...). Roles outside
   * the canonical set fall through to the actor-skill-debt branch
   * since they cannot be authority-root or authority-anchor without
   * meeting the role gate.
   */
  readonly role: string | undefined;
  /**
   * True iff at least one other principal in the store has
   * signed_by === this.id. Computed at the call site by walking the
   * full principal list once; classifier itself is graph-free.
   */
  readonly hasChildren: boolean;
  /** True iff .claude/skills/<id>/SKILL.md exists with non-empty body. */
  readonly hasSkill: boolean;
}

/**
 * Pure classifier. Does no I/O, accepts only the projection, returns
 * the category literal. Order of checks matters and is documented:
 *
 *   1. role==='apex' wins regardless of skill presence (authority
 *      dominates skill presence; an apex-role principal that somehow
 *      has a SKILL.md is still authority-root, because the SKILL.md
 *      is meaningful to whoever authored it, not to the consumer
 *      asking "should this principal have a playbook").
 *
 *   2. role==='agent' AND hasChildren is the anchor branch.
 *      hasChildren is the discriminator that separates the trust-
 *      relay layer (claude-agent) from the leaf actors. Without
 *      this clause, claude-agent would fall through to skill-debt
 *      and read as "missing a playbook" when it is by design.
 *
 *   3. hasSkill true is the actor-with-skill branch. Reached only
 *      for leaf agents (we already failed the anchor check) so the
 *      narrowing is sound.
 *
 *   4. Default: actor-skill-debt. The empty case the feature exists
 *      to call out: a leaf actor without a SKILL.md.
 */
export function classifyPrincipal(input: PrincipalClassifierInput): PrincipalCategory {
  if (input.role === 'apex') return 'authority-root';
  if (input.role === 'agent' && input.hasChildren) return 'authority-anchor';
  if (input.hasSkill) return 'actor-with-skill';
  return 'actor-skill-debt';
}
