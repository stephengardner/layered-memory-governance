/**
 * PostCommitValidator: at-commit-time gate for the agentic
 * code-author + diff-based code-author executors.
 *
 * Why this exists
 * ---------------
 * After the executor's commit lands on the local worktree and BEFORE
 * the PR is opened, the substrate needs a fail-fast inspection
 * surface that catches commit-shape violations the upstream pipeline
 * cannot (or chooses not to) enforce. Concrete violations often
 * found only after a full downstream review round-trip:
 *   - empty / no-op diffs the drafter or agent loop reported as
 *     "shipped"
 *   - diffs that touch files the plan did NOT authorize
 *     (blast-radius escape)
 *   - commits with wrong author / committer attribution
 *   - Conventional-Commit title format violations
 *
 * Each violation a downstream reviewer flags is a 5-to-90-minute
 * round trip. A local validator that runs synchronously before the
 * PR opens fails the same case in milliseconds.
 *
 * Contract
 * --------
 * - Validators are pure inspection functions: given the commit input,
 *   return a structured result. No IO beyond reading the supplied
 *   input fields and (for adapters that need it) the local repo
 *   working tree via the supplied `repoDir`.
 * - Severities: `critical` aborts the dispatch and forces the caller
 *   to write a `code-author-revoked` atom; `major` writes a warning
 *   atom but proceeds to PR creation; `minor` is noted only.
 * - Adapters MUST be idempotent: calling validate() twice with the
 *   same input yields the same result.
 * - Adapters that throw are wrapped by the sequencer into a critical
 *   result with the error message in `reason`; never silently fall
 *   through.
 *
 * Pluggability
 * ------------
 * Concrete validators live in `examples/post-commit-validators/`.
 * The substrate retains only the interface + result shape + the
 * sequencer; specific policies (Conventional Commits format, the
 * allowed author email suffixes, declared-target-paths semantics)
 * are example adapters an operator picks per deployment.
 *
 * Note on sequencer semantics
 * ---------------------------
 * The sequencer short-circuits on the first `critical` failure and
 * returns it. `major` and `minor` results from earlier validators
 * in the array are surfaced through the sequencer return value
 * shape (a wrapper that carries the list of non-critical findings)
 * so the caller can write trailing audit atoms without inverting
 * control. A validator that fails with `major` does NOT prevent a
 * later validator from running and returning `critical`; the
 * intent is "every validator is evaluated unless a critical
 * already fired."
 */

export interface PostCommitValidator {
  /**
   * Human-readable name for the validator. Surfaced in audit atoms
   * and sequencer findings so an operator inspecting a revocation
   * can identify which validator fired.
   */
  readonly name: string;
  validate(input: PostCommitValidatorInput): Promise<PostCommitValidatorResult>;
}

export interface PostCommitValidatorInput {
  /** Full commit SHA the executor produced. */
  readonly commitSha: string;
  /** Branch name the commit lives on (pre-push or post-push). */
  readonly branchName: string;
  /**
   * Absolute path to the repository working tree the commit was
   * produced in. Validators that need to spawn `git show` or
   * `git log -1` run them with `cwd=repoDir`.
   */
  readonly repoDir: string;
  /**
   * Unified diff of the commit (typically `git show --format= HEAD`).
   * Supplied by the caller so each validator does not respawn git;
   * empty string is a legal "no diff captured" indicator that
   * validators MAY treat as a violation if they require diff
   * inspection.
   */
  readonly diff: string;
  /**
   * Paths the commit actually touched (typically `git show
   * --name-only --format=`). Caller-supplied so validators do not
   * re-derive from `diff`.
   */
  readonly touchedPaths: ReadonlyArray<string>;
  /**
   * Plan atom shape relevant to the validation. The substrate seam
   * never imports the runtime Atom type; only the fields validators
   * need are listed here so a different downstream consumer can
   * pass a different concrete plan-shape without an interface
   * change.
   */
  readonly plan: PostCommitValidatorPlanInput;
  /** Author identity recorded on the commit (`%an <%ae>`). */
  readonly authorIdentity: PostCommitValidatorAuthorIdentity;
}

export interface PostCommitValidatorPlanInput {
  /** The plan atom id, surfaced in audit atoms for traceability. */
  readonly id: string;
  /**
   * Paths the plan authorized the executor to touch. An empty list
   * means the plan declared no scope; validators that depend on
   * this list (e.g. target-paths-validator) decide their own
   * empty-scope policy.
   */
  readonly target_paths: ReadonlyArray<string>;
  /**
   * The plan's sub-actor delegation block, kept opaque at the seam.
   * Validators that need to read it cast at their boundary; the
   * substrate does not pre-shape the delegation type so consumers
   * with different delegation schemas can still ship validators.
   */
  readonly delegation: unknown;
}

export interface PostCommitValidatorAuthorIdentity {
  readonly name: string;
  readonly email: string;
}

export type PostCommitValidatorSeverity = 'critical' | 'major' | 'minor';

/**
 * Result a single validator returns. Either ok with no payload, or
 * a structured failure carrying the severity and a human-readable
 * reason the caller surfaces in audit atoms.
 */
export type PostCommitValidatorResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly severity: PostCommitValidatorSeverity;
    };

/**
 * Sequencer result. `ok: true` means no critical failures fired;
 * the optional `findings` list carries any major / minor non-blocking
 * results the caller may persist as audit atoms. `ok: false` carries
 * the first critical failure that fired plus the per-validator
 * findings accumulated before it (so a caller can still write a
 * partial audit trail).
 */
export type PostCommitValidatorSequencerResult =
  | {
      readonly ok: true;
      readonly findings: ReadonlyArray<PostCommitValidatorFinding>;
    }
  | {
      readonly ok: false;
      readonly criticalValidatorName: string;
      readonly reason: string;
      readonly findings: ReadonlyArray<PostCommitValidatorFinding>;
    };

/**
 * One entry on the findings list a sequencer accumulates. Carries
 * the validator name + severity + reason so the caller can mint a
 * descriptive audit atom without re-parsing the result shape.
 */
export interface PostCommitValidatorFinding {
  readonly validatorName: string;
  readonly severity: PostCommitValidatorSeverity;
  readonly reason: string;
}

/**
 * Run a list of validators against a single commit input in order.
 *
 * Semantics:
 *   - Every validator is evaluated unless a `critical` already fired.
 *   - A `critical` failure short-circuits and returns immediately;
 *     later validators are NOT invoked.
 *   - `major` and `minor` failures accumulate in `findings` and the
 *     sequencer keeps running.
 *   - A validator that throws is wrapped into a synthetic
 *     critical-severity result (`reason` carries the error message).
 *     This is the same defensive posture the Redactor contract takes:
 *     a thrown validator MUST be treated as catastrophic rather than
 *     silently skipped, because the alternative (proceed-on-throw)
 *     would let an adversarial or buggy validator silently disable
 *     the gate.
 *   - A validator that returns a value the type system would catch
 *     but a JS caller produced (e.g. wrong shape, missing fields) is
 *     defensively wrapped as critical too.
 *
 * The sequencer never mutates its inputs.
 *
 * Concurrency: each call runs its own validator loop in isolation;
 * two parallel calls do not share state (the sequencer is a pure
 * async function). A validator IMPLEMENTATION that shares mutable
 * state is the operator's problem; the sequencer does not synchronize.
 */
export async function runPostCommitValidators(
  validators: ReadonlyArray<PostCommitValidator>,
  input: PostCommitValidatorInput,
): Promise<PostCommitValidatorSequencerResult> {
  const findings: PostCommitValidatorFinding[] = [];
  for (const v of validators) {
    let result: PostCommitValidatorResult;
    try {
      result = await v.validate(input);
    } catch (err) {
      // Defensive: a validator that throws is treated as critical
      // so the gate fails closed. Silently swallowing would let a
      // buggy or hostile validator no-op the check.
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        criticalValidatorName: v.name,
        reason: `validator ${v.name} threw: ${message}`,
        findings: Object.freeze(findings.slice()),
      };
    }
    if (!isWellFormedResult(result)) {
      // Defensive: a validator that returned a shape we cannot
      // reason about must also fail closed. Loose typing at the
      // boundary (mjs callers, dynamic-loaded adapters) can produce
      // any shape; we never trust it.
      return {
        ok: false,
        criticalValidatorName: v.name,
        reason: `validator ${v.name} returned an unrecognized result shape`,
        findings: Object.freeze(findings.slice()),
      };
    }
    if (result.ok) continue;
    if (result.severity === 'critical') {
      return {
        ok: false,
        criticalValidatorName: v.name,
        reason: result.reason,
        findings: Object.freeze(findings.slice()),
      };
    }
    findings.push(
      Object.freeze({
        validatorName: v.name,
        severity: result.severity,
        reason: result.reason,
      }),
    );
  }
  return {
    ok: true,
    findings: Object.freeze(findings.slice()),
  };
}

/**
 * Best-effort shape check for a validator's return value. Returns
 * true only when the object matches one of the two
 * `PostCommitValidatorResult` variants exactly. Defensive: a caller
 * passing through a dynamic-loaded adapter may produce a shape the
 * TS layer cannot catch, and the sequencer's fail-closed posture
 * relies on this gate to refuse unrecognized output.
 *
 * Contradictory `ok: true` shapes (e.g.,
 * `{ ok: true, severity: 'critical', reason: '...' }`) are also
 * refused: the success variant carries no `severity` / `reason`
 * fields, so a payload that asserts both ok and a failure shape is
 * malformed by definition.
 */
function isWellFormedResult(value: unknown): value is PostCommitValidatorResult {
  if (value === null || typeof value !== 'object') return false;
  const v = value as { ok?: unknown; reason?: unknown; severity?: unknown };
  if (v.ok === true) {
    return v.reason === undefined && v.severity === undefined;
  }
  if (v.ok !== false) return false;
  if (typeof v.reason !== 'string') return false;
  return v.severity === 'critical' || v.severity === 'major' || v.severity === 'minor';
}
