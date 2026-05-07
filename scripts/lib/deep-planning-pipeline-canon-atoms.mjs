// Pure builders for the eight L3 policy + ordering atoms the deep
// planning pipeline seeds into canon. The CLI wrapper
// (scripts/bootstrap-deep-planning-pipeline-canon.mjs) shells out to
// this module so the test suite can build atoms off the same data
// without spawning the script.
//
// Atom set:
//   - pol-planning-pipeline-stages-default: registers the 5 default
//     stages (brainstorm-stage, spec-stage, plan-stage, review-stage,
//     dispatch-stage). Read by readPipelineStagesPolicy.
//   - pol-pipeline-stage-hil-<stage>: per-stage HIL pause-mode atom
//     for each of the 5 default stages. Read by
//     readPipelineStageHilPolicy.
//   - pol-planning-pipeline-default-mode: indie-floor default of
//     'single-pass' so a solo developer does not pay the multi-stage
//     cost on a one-line README fix. Read by
//     readPipelineDefaultModePolicy.
//   - pol-planning-pipeline-stage-implementations-default: per-stage
//     adapter selection (agentic vs single-shot). Indie-floor default
//     is single-shot for every stage; flipping a stage to agentic is
//     a higher-priority canon edit. Read by
//     readPipelineStageImplementationsPolicy.
//
// The substrate-shape directive `dev-deep-planning-pipeline` lived
// here as an L0 pending_review stub before operator promotion. After
// the operator ratified it via /decide, the canonical home moved to
// scripts/bootstrap-operator-directives.mjs (alongside the other
// /decide-captured directives), so this module no longer seeds it.
//
// Mechanism (the data + atom builder) lives here; environment and
// host side effects stay in the script. Mirrors the autonomous-intent
// canon-atoms extraction pattern.

const BOOTSTRAP_TIME = '2026-04-28T12:00:00.000Z';
const SOURCE_INTENT = 'operator-intent-deep-planning-pipeline-1777408799112';

/**
 * Default 5-stage ordering shipped to indie deployments. Matches the
 * stage-name values emitted by the reference adapters in
 * examples/planning-stages/ so readPipelineStagesPolicy resolves a
 * stages array the runner can walk without further translation.
 *
 * brainstorm-stage runs as brainstorm-actor (read-only research),
 * spec-stage as spec-author (cited-paths verification), plan-stage as
 * plan-author (cited target_paths + delegation verification), review-stage as
 * pipeline-auditor (read-only auditor), dispatch-stage as
 * plan-dispatcher (hands off to runDispatchTick). All five share one
 * read-only-author shape so the canon-at-runtime panel resolves uniformly
 * for every stage; plan-author was added 2026-05-06 to close the gap
 * where plan-stage previously inherited cto-actor's broader strategic
 * planner canon and the panel rendered empty for resolved policy atoms.
 */
export const DEFAULT_PIPELINE_STAGES = Object.freeze([
  Object.freeze({ name: 'brainstorm-stage', principal_id: 'brainstorm-actor' }),
  Object.freeze({ name: 'spec-stage', principal_id: 'spec-author' }),
  Object.freeze({ name: 'plan-stage', principal_id: 'plan-author' }),
  Object.freeze({ name: 'review-stage', principal_id: 'pipeline-auditor' }),
  Object.freeze({ name: 'dispatch-stage', principal_id: 'plan-dispatcher' }),
]);

/**
 * Indie-floor HIL defaults. brainstorm + review run autonomously
 * because they are read-only; spec + plan + dispatch pause on
 * critical findings so the operator inspects before the pipeline
 * mutates downstream state.
 */
export const PIPELINE_STAGE_HIL_DEFAULTS = Object.freeze({
  'brainstorm-stage': 'never',
  'spec-stage': 'on-critical-finding',
  'plan-stage': 'on-critical-finding',
  'review-stage': 'never',
  'dispatch-stage': 'on-critical-finding',
});

/**
 * Indie-floor default pipeline mode. The solo developer running a
 * one-line README fix is not paying the brainstorm + spec + review
 * tax; an org-ceiling deployment that has decided every plan goes
 * through the deep pipeline flips this via a higher-priority canon
 * atom rather than a code change.
 */
export const DEFAULT_PIPELINE_MODE = 'single-pass';

/**
 * Indie-floor default per-stage adapter mode. Every stage ships at
 * 'single-shot' so a deployment inherits the existing host.llm.judge
 * behavior on first install. Flipping a stage to 'agentic' is a
 * conscious canon edit (higher-priority pol- atom) per
 * dev-indie-floor-org-ceiling: the more expensive path is opt-in.
 *
 * Today only brainstorm-stage has an agentic adapter shipped (PR
 * #280); the other four entries reserve their slot so an operator's
 * canon edit cannot silently activate an adapter that does not yet
 * exist (the wiring layer halts loud on a missing adapter).
 */
export const DEFAULT_STAGE_IMPLEMENTATION_MODES = Object.freeze({
  'brainstorm-stage': 'single-shot',
  'spec-stage': 'single-shot',
  'plan-stage': 'single-shot',
  'review-stage': 'single-shot',
  'dispatch-stage': 'single-shot',
});

function ensureOperatorId(operatorId, label) {
  if (typeof operatorId !== 'string' || operatorId.length === 0) {
    throw new Error(`${label}: operatorId is required`);
  }
}

/**
 * Build the canonical specs (data only) for the eight pipeline canon
 * atoms. Pure: same input -> same output, ready for the CLI wrapper
 * to walk into buildAtomFromSpec or for the test to assert against.
 *
 * operatorId seeds principal_id (so a deployment's seed ships under
 * its operator principal) and the per-stage allowed_resumers list (so
 * an HIL-paused stage resumes only on an atom signed by that
 * principal). A hardcoded principal id would lock the seed to one
 * deployment.
 */
export function buildDeepPlanningPipelineSpecs(operatorId) {
  ensureOperatorId(operatorId, 'buildDeepPlanningPipelineSpecs');

  const sharedDerivedFrom = Object.freeze([
    'inv-l3-requires-human',
    'inv-governance-before-autonomy',
    'inv-kill-switch-first',
    'inv-provenance-every-write',
    'arch-atomstore-source-of-truth',
    'arch-host-interface-boundary',
    'dev-substrate-not-prescription',
    'dev-indie-floor-org-ceiling',
    'dev-canon-is-strategic-not-tactical',
    'dev-judgment-ladder-required-for-llm-actors',
    'dev-drafter-citation-verification-required',
    SOURCE_INTENT,
  ]);

  const hilSpecs = DEFAULT_PIPELINE_STAGES.map((stage) => ({
    id: `pol-pipeline-stage-hil-${stage.name}`,
    type: 'directive',
    layer: 'L3',
    content:
      `HIL pause-mode policy for the ${stage.name} step of the deep planning pipeline. `
      + `pause_mode='${PIPELINE_STAGE_HIL_DEFAULTS[stage.name]}' is the indie-floor default per the `
      + 'spec section 8 ladder: read-only stages run autonomously; stages that mutate '
      + 'downstream state (spec, plan, dispatch) pause on critical findings so the operator '
      + 'inspects before the pipeline advances. allowed_resumers ships with the configured '
      + 'operator principal only; widening to a delegated human or bot resumer is a conscious '
      + 'canon edit, not a config knob.',
    policy: {
      subject: 'pipeline-stage-hil',
      stage_name: stage.name,
      pause_mode: PIPELINE_STAGE_HIL_DEFAULTS[stage.name],
      auto_resume_after_ms: null,
      allowed_resumers: [operatorId],
    },
    alternatives_rejected: [
      'Ship pause_mode=always for every stage; safest but breaks the indie-floor cost story',
      'Ship pause_mode=never for every stage; trades the spec-section-8 default-deny gate for speed',
      'Embed HIL defaults as framework constants instead of canon atoms; loses the canon-edit knob',
    ],
    what_breaks_if_revisit:
      'Sound at 3 months: per-stage atoms are additive (a new stage ships its own pol- atom); '
      + 'tightening pause_mode requires only a canon edit visible in the diff. Loosening below '
      + "the spec-section-8 default-deny ladder would re-open the dev-drafter-citation-"
      + "verification-required gap the review stage exists to close.",
    derived_from: sharedDerivedFrom,
  }));

  return [
    {
      id: 'pol-planning-pipeline-stages-default',
      type: 'directive',
      layer: 'L3',
      content:
        'Default 5-stage ordering for the deep planning pipeline: brainstorm-stage -> '
        + 'spec-stage -> plan-stage -> review-stage -> dispatch-stage. Indie deployments '
        + 'inherit this set; org-ceiling deployments register a higher-priority '
        + 'pol-planning-pipeline-stages-<scope> atom (per spec section 7) to insert '
        + 'legal-review, security-threat-model, perf-benchmark, or any custom stage. The '
        + 'orchestrator enforces only two structural invariants regardless of policy: '
        + 'dispatch-stage is terminal, and review-stage must follow plan-stage if both are '
        + 'present. All other ordering is policy-defined per dev-substrate-not-prescription.',
      policy: {
        subject: 'planning-pipeline-stages',
        scope: 'project',
        stages: DEFAULT_PIPELINE_STAGES.map((s) => ({
          name: s.name,
          principal_id: s.principal_id,
        })),
      },
      alternatives_rejected: [
        'Hardcode the default stage list as a framework constant in src/runtime/planning-pipeline/runner.ts',
        'Ship a two-stage default (plan + dispatch) and let consumers add brainstorm/spec/review optionally',
        'Encode stage ordering as a static export in scripts/lib/ rather than a canon policy atom',
      ],
      what_breaks_if_revisit:
        'Sound at 3 months: stages list is additive and policy-arbitrated. Inserting or '
        + 'removing a stage is a canon edit visible in the diff; the orchestrator validates '
        + 'the resolved list at pre-flight (malformed or unknown stage principal halts the '
        + 'pipeline with a pipeline-failed atom citing the malformation).',
      derived_from: sharedDerivedFrom,
    },
    ...hilSpecs,
    {
      id: 'pol-planning-pipeline-default-mode',
      type: 'directive',
      layer: 'L3',
      content:
        `Default pipeline mode is '${DEFAULT_PIPELINE_MODE}' per dev-indie-floor-org-ceiling. A solo `
        + 'developer running a typo-fix should not pay the brainstorm + spec + review tax; '
        + 'invoking with --mode=substrate-deep activates the multi-stage path explicitly. An '
        + 'org-ceiling deployment that has decided every plan goes through the deep pipeline '
        + 'flips this default via a higher-priority canon atom (e.g. a project-scope atom '
        + "setting mode='substrate-deep'); raising the dial is a canon edit, not a code change.",
      policy: {
        subject: 'planning-pipeline-default-mode',
        mode: DEFAULT_PIPELINE_MODE,
      },
      alternatives_rejected: [
        'Default to substrate-deep so every plan gets the spec/review pipeline; breaks indie-floor cost story',
        'Hardcode the default in run-cto-actor.mjs argv handling rather than a canon policy atom',
        'Ship without a default-mode policy and rely solely on the --mode flag',
      ],
      what_breaks_if_revisit:
        'Sound at 3 months: a deployment that wants substrate-deep by default writes a '
        + 'higher-priority canon atom; arbitration resolves it via the existing source-rank '
        + 'formula. The default-mode atom is a feature flag with a deterministic default.',
      derived_from: sharedDerivedFrom,
    },
    {
      id: 'pol-planning-pipeline-stage-implementations-default',
      type: 'directive',
      layer: 'L3',
      content:
        'Default per-stage adapter selection for the deep planning pipeline. Every stage '
        + "ships at 'single-shot' (the existing host.llm.judge behavior) so a fresh deployment "
        + "inherits known-cost defaults. Flipping a stage to 'agentic' (a dispatched agent-loop "
        + 'session bundled with a superpowers skill) is a conscious canon edit per '
        + 'dev-indie-floor-org-ceiling: the higher-cost, higher-rigor path is opt-in. Today only '
        + 'brainstorm-stage has an agentic adapter shipped; the other four entries reserve their '
        + 'slot so an operator-edit that activates an unimplemented adapter halts loud at '
        + 'registry-construction time rather than silently falling back. Read by '
        + 'readPipelineStageImplementationsPolicy; resolved alongside readPipelineStagesPolicy '
        + 'at registry-construction in run-cto-actor.mjs (and its peers).',
      policy: {
        subject: 'planning-pipeline-stage-implementations',
        scope: 'project',
        // Fail-fast guard: a stage in DEFAULT_PIPELINE_STAGES whose
        // mode is missing from DEFAULT_STAGE_IMPLEMENTATION_MODES
        // would silently emit an entry with mode=undefined, which the
        // policy reader's fail-closed shape reduces to an empty map
        // and the wiring layer treats as "stage not selected" -- a
        // silent default-to-single-shot regardless of the operator's
        // canon edit. The .mjs builders are NOT type-checked by tsc,
        // so a string-literal drift between the two constants would
        // not surface at build time. Throw at bootstrap-generation
        // time instead so the failure is loud and traceable to the
        // exact stage name that drifted.
        implementations: DEFAULT_PIPELINE_STAGES.map((s) => {
          const mode = DEFAULT_STAGE_IMPLEMENTATION_MODES[s.name];
          if (mode !== 'agentic' && mode !== 'single-shot') {
            throw new Error(
              `DEFAULT_STAGE_IMPLEMENTATION_MODES is missing or invalid for stage `
              + `'${s.name}' (got ${JSON.stringify(mode)}). Add an entry to `
              + 'DEFAULT_STAGE_IMPLEMENTATION_MODES whose value is one of '
              + "'agentic' | 'single-shot' before bootstrap.",
            );
          }
          return { stage_name: s.name, mode };
        }),
      },
      alternatives_rejected: [
        'Conflate the implementations list with pol-planning-pipeline-stages-default; couples two independent canon dimensions and forces a deployment that wants to keep the default ordering but flip one stage to agentic to reproduce the entire stages list',
        'Default every stage to agentic; trades the indie-floor cost story for a more rigorous default that surprises a solo developer running a typo-fix',
        'Hardcode the per-stage implementation choice in run-cto-actor.mjs; loses the canon-edit knob and forces a code change for what is a deployment-policy decision',
      ],
      what_breaks_if_revisit:
        'Sound at 3 months: per-stage entries are additive (a future agentic spec-stage ships '
        + 'with a canon atom flipping spec-stage to agentic; the canon-default atom requires no '
        + 'edit). Switching a deployment to agentic-by-default is a higher-priority pol- atom '
        + 'visible in the diff. The wiring layer fail-loud on a stage whose declared adapter is '
        + 'not registered prevents silent drift between policy and implementation.',
      derived_from: sharedDerivedFrom,
    },
  ];
}

/**
 * Lift a spec into a fully-formed canon Atom.
 *
 * Policy specs carry an optional `policy` block; when present it lands
 * under `metadata.policy`. The substrate-shape spec carries
 * `validation_status` so the L0-pending gate surfaces in atom.signals.
 */
export function buildAtomFromSpec(spec, operatorId) {
  ensureOperatorId(operatorId, 'buildAtomFromSpec');
  const metadata = {
    alternatives_rejected: spec.alternatives_rejected,
    what_breaks_if_revisit: spec.what_breaks_if_revisit,
  };
  if (spec.policy !== undefined) {
    metadata.policy = spec.policy;
  }
  const validationStatus =
    typeof spec.validation_status === 'string' && spec.validation_status.length > 0
      ? spec.validation_status
      : 'unchecked';
  return {
    schema_version: 1,
    id: spec.id,
    content: spec.content,
    type: spec.type,
    layer: spec.layer,
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'bootstrap-deep-planning-pipeline-canon', agent_id: 'bootstrap' },
      derived_from: [...spec.derived_from],
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
      validation_status: validationStatus,
      last_validated_at: null,
    },
    principal_id: operatorId,
    taint: 'clean',
    metadata,
  };
}

export function buildDeepPlanningPipelineAtoms(operatorId) {
  return buildDeepPlanningPipelineSpecs(operatorId).map((spec) =>
    buildAtomFromSpec(spec, operatorId),
  );
}
