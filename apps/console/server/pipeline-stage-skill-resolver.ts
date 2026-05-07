/**
 * Resolves the vendored skill-bundle name for a pipeline-stage
 * principal-id, OR returns null when the id is not one of the five
 * canonical pipeline-stage principals.
 *
 * Why this exists
 * ---------------
 * The five pipeline-stage principals (brainstorm-actor, spec-author,
 * plan-author, pipeline-auditor, plan-dispatcher) carry their soul as
 * a vendored superpowers skill bundle under
 * `examples/planning-stages/skills/<bundle>.md`, NOT a per-principal
 * `.claude/skills/<id>/SKILL.md` file. The console's principal-skill
 * endpoint defaults to the per-principal path, which classifies these
 * principals as `actor-skill-debt` even though their soul exists at
 * the bundle path. This resolver is the single point of truth that
 * routes a pipeline-stage principal-id to its bundle name.
 *
 * Source-of-truth coupling
 * ------------------------
 * The forward stage-mapping lives at
 * `examples/planning-stages/lib/stage-mapping.ts` (STAGE_TABLE). This
 * resolver inverts that table at module init keyed by principal-id.
 * Adding a new pipeline stage updates STAGE_TABLE +
 * PIPELINE_STAGE_NAMES; this resolver follows the change with no
 * edits here. Adding a new principal-id WITHOUT going through
 * STAGE_TABLE keeps that principal on the per-principal-SKILL.md path,
 * which is the correct fallback for a non-pipeline actor.
 *
 * Substrate purity
 * ----------------
 * Lives under `apps/console/server/` because this is instance policy
 * (which principals are pipeline stages, where their souls live), not
 * a framework primitive. The forward STAGE_TABLE under examples/ is
 * the substrate; this resolver consumes it.
 */

import { bindingForStage } from '../../../examples/planning-stages/lib/stage-mapping.js';

/**
 * The canonical pipeline-stage names the resolver iterates. Mirrors
 * `PIPELINE_STAGE_NAMES` in stage-mapping.ts; duplicated here as a
 * literal because importing the runtime const would require a
 * single-purpose `as const` re-export and the substrate-deep
 * deliberation that produced this resolver decided the literal is
 * stable enough for the indie-floor default. A new pipeline stage
 * requires editing STAGE_TABLE in stage-mapping.ts (canonical) AND
 * appending to this list. The duplication is intentional and
 * surfaced as a single-edit-per-change pattern via this comment.
 */
const CANONICAL_STAGES = [
  'brainstorm-stage',
  'spec-stage',
  'plan-stage',
  'review-stage',
  'dispatch-stage',
] as const;

const PIPELINE_STAGE_PRINCIPAL_TO_BUNDLE: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const stageName of CANONICAL_STAGES) {
    const binding = bindingForStage(stageName);
    if (binding !== null) {
      map.set(binding.principalId, binding.skillBundle);
    }
  }
  return map;
})();

/**
 * Returns the skill-bundle name for a pipeline-stage principal-id, OR
 * `null` if the id is not one of the five canonical pipeline-stage
 * principals. The bundle name is the input to `resolveSkillBundle()`.
 */
export function pipelineStagePrincipalSkillBundle(
  principalId: string,
): string | null {
  return PIPELINE_STAGE_PRINCIPAL_TO_BUNDLE.get(principalId) ?? null;
}

/**
 * Test-only exposure of the full inverted map so a parity test can
 * walk every entry against the forward STAGE_TABLE without re-deriving
 * the inversion in the test file.
 */
export function _pipelineStagePrincipalSkillBundleMapForTests(): ReadonlyMap<string, string> {
  return PIPELINE_STAGE_PRINCIPAL_TO_BUNDLE;
}
