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

const VALID_MODES = Object.freeze(['single-pass', 'substrate-deep']);

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
 * Parse the run-cto-actor CLI flag set. Mirrors the surface of the
 * inline parseArgs that previously lived in scripts/run-cto-actor.mjs;
 * extracted into this lib so the --mode flag (and future driver flags)
 * carry test coverage.
 *
 * Returns { ok: false, reason } on missing-required and unknown-flag
 * errors so the caller decides between a usage hint and a fatal exit.
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
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--request' && i + 1 < argv.length) {
      args.request = argv[++i];
    } else if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a === '--stub') {
      args.stub = true;
    } else if (a === '--classify-model' && i + 1 < argv.length) {
      args.classifyModel = argv[++i];
    } else if (a === '--draft-model' && i + 1 < argv.length) {
      args.draftModel = argv[++i];
    } else if (a === '--max-budget-usd' && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) {
        return { ok: false, reason: '--max-budget-usd expects a positive number' };
      }
      args.maxBudgetUsdPerCall = n;
    } else if (a === '--timeout-ms' && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) {
        return { ok: false, reason: '--timeout-ms expects a positive number' };
      }
      args.timeoutMs = n;
    } else if (a === '--min-confidence' && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        return { ok: false, reason: '--min-confidence expects a number in [0,1]' };
      }
      args.minConfidence = n;
    } else if (a === '--max-iterations' && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) {
        return { ok: false, reason: '--max-iterations expects a positive integer' };
      }
      args.maxIterations = n;
    } else if (a === '--principal' && i + 1 < argv.length) {
      args.principalId = argv[++i];
    } else if (a === '--origin' && i + 1 < argv.length) {
      args.origin = argv[++i];
    } else if (a === '--intent-id' && i + 1 < argv.length) {
      args.intentId = argv[++i];
    } else if (a === '--delegate-to' && i + 1 < argv.length) {
      const v = argv[++i];
      if (typeof v !== 'string' || v.trim().length === 0) {
        return { ok: false, reason: '--delegate-to expects a non-empty principal id' };
      }
      args.delegateTo = v;
    } else if (a === '--mode') {
      if (i + 1 >= argv.length) {
        return { ok: false, reason: `--mode expects one of: ${VALID_MODES.join(', ')}` };
      }
      const v = argv[++i];
      if (!VALID_MODES.includes(v)) {
        return {
          ok: false,
          reason: `--mode expects one of: ${VALID_MODES.join(', ')}; got "${v}"`,
        };
      }
      args.mode = v;
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
