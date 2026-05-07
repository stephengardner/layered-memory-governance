/**
 * Pure helpers for scripts/run-cto-actor.mjs.
 *
 * Lives in scripts/lib/ (no shebang, no top-level side effects) so
 * vitest+esbuild on Windows-CI can import them from a .test.ts without
 * tripping the shebang loader. Same pattern as scripts/lib/intend.mjs
 * and scripts/lib/plan-approve-telegram.mjs.
 *
 * Surface:
 *   parseRunCtoActorArgs(argv: string[])
 *     -> { ok: true, args }
 *     -> { ok: false, reason: string }
 *
 * The driver script wraps this with process.argv slicing and an
 * exit(2) on !ok; the helper itself is pure so tests cover the full
 * flag matrix without spawning a subprocess.
 */

// Single source of truth for legal --mode values. Exported so any
// caller that builds an argv targeting run-cto-actor.mjs (intend.mjs
// today; future drivers next) validates against the same list this
// script's own --mode parser does, instead of duplicating the
// literals and risking silent drift when a third mode lands.
export const VALID_MODES = Object.freeze(['single-pass', 'substrate-deep']);

/**
 * Default mode is single-pass. Indie-floor posture: a solo developer
 * running `node scripts/run-cto-actor.mjs --request "..."` should
 * never accidentally pay the multi-stage substrate-deep cost on a
 * one-line clarification. The substrate-deep path is opt-in via
 * --mode substrate-deep and routes through the planning-pipeline
 * runner instead of the single-pass PlanningActor.
 */
export const DEFAULT_MODE = 'single-pass';

/**
 * Names of boolean flags that cannot accept an =-form value. The
 * GNU-style helper rejects `--dry-run=true` so a typo like
 * `--dry-run=ok` does not silently flip the toggle.
 */
const BOOL_FLAGS = Object.freeze(['--dry-run', '--stub', '-h', '--help']);

/**
 * Split a single argv entry into its flag name and inline value.
 * Returns the inline value when the entry is `--key=value`, otherwise
 * `null` to signal the legacy space-form `--key value` and let the
 * caller consume the next argv slot.
 */
function splitFlagAndValue(arg) {
  if (typeof arg !== 'string' || !arg.startsWith('--')) {
    return { flag: arg, inline: null };
  }
  const eq = arg.indexOf('=');
  if (eq < 0) return { flag: arg, inline: null };
  return { flag: arg.slice(0, eq), inline: arg.slice(eq + 1) };
}

/**
 * Parse the run-cto-actor CLI flag set. Mirrors the surface of the
 * inline parseArgs that previously lived in scripts/run-cto-actor.mjs;
 * extracted into this lib so the --mode flag (and future driver flags)
 * carry test coverage.
 *
 * Returns { ok: false, reason } on missing-required and unknown-flag
 * errors so the caller decides between a usage hint and a fatal exit.
 *
 * Accepts both `--key value` (space-form) and `--key=value` (=-form,
 * GNU-style) for value-bearing flags. Boolean flags (--dry-run, --stub,
 * --help) reject the =-form per the BOOL_FLAGS guard, so a typo like
 * `--dry-run=ok` is caught loudly instead of silently flipping the
 * toggle.
 *
 * Note: numeric / range validation for --max-budget-usd, --timeout-ms,
 * --min-confidence, --max-iterations remains in the driver itself for
 * V1 because those flags pre-date this extraction; folding them in is
 * a separate refactor that does not gate the --mode wiring.
 */
export function parseRunCtoActorArgs(argv) {
  const args = {
    request: null,
    dryRun: false,
    maxIterations: 2,
    principalId: 'cto-actor',
    origin: 'operator',
    stub: false,
    classifyModel: undefined,
    draftModel: undefined,
    maxBudgetUsdPerCall: undefined,
    timeoutMs: undefined,
    minConfidence: undefined,
    delegateTo: undefined,
    intentId: null,
    mode: DEFAULT_MODE,
    invokersPath: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const { flag: a, inline } = splitFlagAndValue(raw);
    // Boolean flags must not carry an inline value. Catch typos like
    // `--dry-run=true` loudly rather than silently accepting.
    if (inline !== null && BOOL_FLAGS.includes(a)) {
      return { ok: false, reason: `boolean flag ${a} does not accept a value` };
    }
    /**
     * Consume the value for the current flag. Inline form returns the
     * captured string in one step; space form advances the cursor. The
     * helper centralises the pre-read length check so individual flag
     * branches stay focused on validation.
     */
    const consumeValue = () => {
      if (inline !== null) return { ok: true, value: inline };
      if (i + 1 >= argv.length) return { ok: false };
      i += 1;
      return { ok: true, value: argv[i] };
    };
    /**
     * Read a required string value for the current flag and route a
     * uniform reason on missing-value. Centralises the consumeValue +
     * ok-check pattern that previously appeared in every per-flag
     * branch. Returns either { ok: true, value } or { ok: false, reason }.
     */
    const readRequiredValue = (reason) => {
      const v = consumeValue();
      if (!v.ok) return { ok: false, reason };
      return { ok: true, value: v.value };
    };
    /**
     * Read a numeric value for the current flag, validate via the
     * supplied predicate, and route a uniform reason on either a
     * missing value or a predicate failure. The predicate receives the
     * parsed Number and returns true when the value is acceptable.
     */
    const readNumber = (reason, predicate) => {
      const v = consumeValue();
      if (!v.ok) return { ok: false, reason };
      const n = Number(v.value);
      if (!predicate(n)) return { ok: false, reason };
      return { ok: true, value: n };
    };
    if (a === '--request') {
      const v = readRequiredValue('--request "<text>" is required');
      if (!v.ok) return v;
      args.request = v.value;
    } else if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a === '--stub') {
      args.stub = true;
    } else if (a === '--classify-model') {
      const v = readRequiredValue('--classify-model expects a value');
      if (!v.ok) return v;
      args.classifyModel = v.value;
    } else if (a === '--draft-model') {
      const v = readRequiredValue('--draft-model expects a value');
      if (!v.ok) return v;
      args.draftModel = v.value;
    } else if (a === '--max-budget-usd') {
      const v = readNumber(
        '--max-budget-usd expects a positive number',
        (n) => Number.isFinite(n) && n > 0,
      );
      if (!v.ok) return v;
      args.maxBudgetUsdPerCall = v.value;
    } else if (a === '--timeout-ms') {
      const v = readNumber(
        '--timeout-ms expects a positive number',
        (n) => Number.isFinite(n) && n > 0,
      );
      if (!v.ok) return v;
      args.timeoutMs = v.value;
    } else if (a === '--min-confidence') {
      const v = readNumber(
        '--min-confidence expects a number in [0,1]',
        (n) => Number.isFinite(n) && n >= 0 && n <= 1,
      );
      if (!v.ok) return v;
      args.minConfidence = v.value;
    } else if (a === '--max-iterations') {
      const v = readNumber(
        '--max-iterations expects a positive integer',
        (n) => Number.isInteger(n) && n >= 1,
      );
      if (!v.ok) return v;
      args.maxIterations = v.value;
    } else if (a === '--principal') {
      const v = readRequiredValue('--principal expects a value');
      if (!v.ok) return v;
      args.principalId = v.value;
    } else if (a === '--origin') {
      const v = readRequiredValue('--origin expects a value');
      if (!v.ok) return v;
      args.origin = v.value;
    } else if (a === '--intent-id') {
      const v = readRequiredValue('--intent-id expects a value');
      if (!v.ok) return v;
      args.intentId = v.value;
    } else if (a === '--delegate-to') {
      const v = readRequiredValue('--delegate-to expects a non-empty principal id');
      if (!v.ok) return v;
      // Trim before persistence: a quoted argv slot like "code-author "
      // would otherwise misroute identity matching downstream. Normalise
      // here so every consumer sees the canonical principal id.
      const trimmed =
        typeof v.value === 'string' ? v.value.trim() : v.value;
      if (typeof trimmed !== 'string' || trimmed.length === 0) {
        return { ok: false, reason: '--delegate-to expects a non-empty principal id' };
      }
      args.delegateTo = trimmed;
    } else if (a === '--mode') {
      const v = readRequiredValue(
        `--mode expects one of: ${VALID_MODES.join(', ')}`,
      );
      if (!v.ok) return v;
      if (!VALID_MODES.includes(v.value)) {
        return {
          ok: false,
          reason: `--mode expects one of: ${VALID_MODES.join(', ')}; got "${v.value}"`,
        };
      }
      args.mode = v.value;
    } else if (a === '--invokers') {
      // Path to an .mjs module whose default export is
      // `async (host, registry) => void`. Mirrors run-approval-cycle.mjs
      // so the substrate-deep dispatch-stage shares the SAME registrar
      // module the approval-cycle daemon uses; no parallel wiring,
      // no parallel maintenance burden. Indie-floor default is null
      // (auditor-only registry); org-ceiling deployments wire
      // scripts/invokers/autonomous-dispatch.mjs to register code-author
      // and any other sub-actors. Validated at consume time (driver
      // resolves the path and exit(2) on missing-file / wrong-shape).
      //
      // Guard against `--invokers=` (empty inline), `--invokers --mode`
      // (long-flag consumed as value), and `--invokers -h` (short-flag
      // consumed as value): readRequiredValue would otherwise assign
      // '' / '--mode' / '-h' to invokersPath, and the failure mode
      // would surface much later as a less-actionable path-resolution
      // error in the driver. Reject any leading-dash value; trim before
      // persistence so a quoted argv like " ./path " normalises here.
      const v = readRequiredValue('--invokers expects a path to an .mjs module');
      if (!v.ok) return v;
      const trimmed =
        typeof v.value === 'string' ? v.value.trim() : v.value;
      if (
        typeof trimmed !== 'string'
        || trimmed.length === 0
        || trimmed.startsWith('-')
      ) {
        return { ok: false, reason: '--invokers expects a path to an .mjs module' };
      }
      args.invokersPath = trimmed;
    } else if (a === '-h' || a === '--help') {
      args.help = true;
    } else if (typeof a === 'string' && a.startsWith('--')) {
      return { ok: false, reason: `unknown option: ${a}` };
    } else {
      return { ok: false, reason: `unknown argument: ${a}` };
    }
  }
  if (args.request === null && !args.help) {
    return { ok: false, reason: '--request "<text>" is required' };
  }
  return { ok: true, args };
}
