/**
 * Public-surface smoke tests for every subpath in `package.json#exports`.
 *
 * Why: package.json exports promises these subpaths to external consumers.
 * Each barrel documents a specific value + type surface. A silent
 * regression (barrel drift, renamed export, shim re-exporting the wrong
 * path) would break downstream imports at install time but pass every
 * other test in this repo, which exercises modules by their internal
 * paths. This smoke guards the public contract.
 *
 * Shape (table-driven):
 *   Each row is one subpath barrel. Invariants per row are identical,
 *   so adding a new subpath is a one-line row addition, not another
 *   describe block.
 *
 * Invariants per subpath:
 *   1. Shim equivalence (only when a shim exists): the compat shim at
 *      `src/<subpath>` that the package.json `exports` map resolves to
 *      via `dist/<subpath>` must export the same key set as the real
 *      runtime barrel at `src/runtime/<subpath>`. Catches a mis-targeted
 *      re-export path that TypeScript would not flag at runtime. Not
 *      every subpath has a shim: `/adapters/*`, `/external/*`, and
 *      `/lifecycle` live at their final path already, so the `real`
 *      field on the row is optional.
 *   2. Surface pin: `Object.keys` equals the documented allowlist.
 *      Adding or removing an export requires updating this test on
 *      purpose; silent expansion of the public surface is rejected.
 *   3. Definedness: every documented value is `!== undefined` so an
 *      export-deletion regression (binding vanished; TypeScript might
 *      still compile if every import site uses `type`-only imports)
 *      cannot pass. An optional `classes` list additionally asserts
 *      `.prototype` is defined, so a class-became-undefined regression
 *      cannot pass either. Not asserting `typeof === 'function'`
 *      because some subpaths legitimately export constants (ordering
 *      policy objects, number defaults, schema literals).
 *
 * Type exports are intentionally not asserted here: types erase at
 * runtime. They are covered at compile time by `tsc --noEmit`.
 */

import { describe, expect, it } from 'vitest';

// /actors family (shim + real)
import * as actorsShim from '../../src/actors/index.js';
import * as actorsReal from '../../src/runtime/actors/index.js';
import * as prLandingShim from '../../src/actors/pr-landing/index.js';
import * as prLandingReal from '../../src/runtime/actors/pr-landing/index.js';
import * as codeAuthorShim from '../../src/actors/code-author/index.js';
import * as codeAuthorReal from '../../src/runtime/actors/code-author/index.js';
import * as prReviewShim from '../../src/actors/pr-review/index.js';
import * as prReviewReal from '../../src/runtime/actors/pr-review/index.js';
import * as planningShim from '../../src/actors/planning/index.js';
import * as planningReal from '../../src/runtime/actors/planning/index.js';
import * as provisioningShim from '../../src/actors/provisioning/index.js';
import * as provisioningReal from '../../src/runtime/actors/provisioning/index.js';

// /actor-message family (shim + real)
import * as actorMessageShim from '../../src/actor-message/index.js';
import * as actorMessageReal from '../../src/runtime/actor-message/index.js';
import * as executorDefaultShim from '../../src/actor-message/executor-default.js';
import * as executorDefaultReal from '../../src/runtime/actor-message/executor-default.js';

// /adapters family (no shim; this IS the final path)
import * as memoryAdapter from '../../src/adapters/memory/index.js';
import * as fileAdapter from '../../src/adapters/file/index.js';
import * as bridgeAdapter from '../../src/adapters/bridge/index.js';
import * as notifierAdapter from '../../src/adapters/notifier/index.js';

// /external and /lifecycle (no shim; this IS the final path)
import * as githubExternal from '../../src/external/github/index.js';
import * as githubAppExternal from '../../src/external/github-app/index.js';
import * as lifecycle from '../../src/lifecycle/index.js';

interface SubpathCase {
  readonly subpath: string;
  readonly mod: Record<string, unknown>;
  readonly real?: Record<string, unknown>;
  readonly expected: readonly string[];
  readonly classes?: readonly string[];
}

const cases: readonly SubpathCase[] = [
  // /actors family
  {
    subpath: '/actors',
    mod: actorsShim,
    real: actorsReal,
    expected: ['runActor'],
  },
  {
    subpath: '/actors/pr-landing',
    mod: prLandingShim,
    real: prLandingReal,
    expected: [
      'PrLandingActor',
      'mkPrObservationAtom',
      'mkPrObservationAtomId',
      'mkPrObservationFailedAtom',
      'renderPrObservationBody',
    ],
    classes: ['PrLandingActor'],
  },
  {
    subpath: '/actors/code-author',
    mod: codeAuthorShim,
    real: codeAuthorReal,
    expected: [
      'CodeAuthorActor',
      'CodeAuthorFenceError',
      'DRAFT_SCHEMA',
      'DRAFT_SYSTEM_PROMPT',
      'DrafterError',
      'FENCE_ATOM_IDS',
      'GitOpsError',
      'PrCreationError',
      'applyDraftBranch',
      'createDraftPr',
      'draftCodeChange',
      'loadCodeAuthorFence',
      'looksLikeUnifiedDiff',
      'renderPrBody',
    ],
    classes: ['CodeAuthorActor'],
  },
  {
    subpath: '/actors/pr-review',
    mod: prReviewShim,
    real: prReviewReal,
    expected: ['GitHubPrReviewAdapter', 'UserAccountCommentTrigger', 'getTokenFromEnv'],
    classes: ['GitHubPrReviewAdapter', 'UserAccountCommentTrigger'],
  },
  {
    subpath: '/actors/planning',
    mod: planningShim,
    real: planningReal,
    expected: [
      'DEFAULT_JUDGE_TIMEOUT_MS',
      'DEFAULT_MAX_BUDGET_USD_PER_CALL',
      'HostLlmPlanningJudgment',
      'PlanningActor',
      'aggregateRelevantContext',
    ],
    classes: ['HostLlmPlanningJudgment', 'PlanningActor'],
  },
  {
    subpath: '/actors/provisioning',
    mod: provisioningShim,
    real: provisioningReal,
    expected: [
      'assessRoleRisk',
      'buildManifestUrl',
      'createCredentialsStore',
      'findRole',
      'loadRoleRegistry',
      'provisionRole',
      'roleDefinitionSchema',
      'rolePermissionsSchema',
      'roleRegistrySchema',
      'startCallbackServer',
    ],
  },

  // /actor-message family
  {
    subpath: '/actor-message',
    mod: actorMessageShim,
    real: actorMessageReal,
    expected: [
      'ActorMessageRateLimiter',
      'CircuitBreakerOpenError',
      'DEFAULT_ORDERING_POLICY',
      'FALLBACK_AUTO_APPROVE',
      'FALLBACK_PLAN_APPROVAL',
      'RateLimitedError',
      'ResetAuthorityError',
      'ResetShapeError',
      'SubActorRegistry',
      'defaultOrdering',
      'emitAck',
      'escalationAtomId',
      'listUnread',
      'mkCodeAuthorInvokedAtomId',
      'pickNextMessage',
      'readOrderingPolicy',
      'renderEscalationBody',
      'runAuditor',
      'runAutoApprovePass',
      'runCodeAuthor',
      'runDispatchTick',
      'runInboxPoller',
      'runPlanApprovalTick',
      'sendOperatorEscalation',
      'shouldEscalate',
      'validateResetWrite',
    ],
    classes: ['ActorMessageRateLimiter', 'SubActorRegistry'],
  },
  {
    subpath: '/actor-message/executor-default',
    mod: executorDefaultShim,
    real: executorDefaultReal,
    expected: ['buildDefaultCodeAuthorExecutor'],
  },

  // /adapters family (no shim)
  {
    subpath: '/adapters/memory',
    mod: memoryAdapter,
    expected: [
      'MemoryAtomStore',
      'MemoryAuditor',
      'MemoryCanonStore',
      'MemoryClock',
      'MemoryLLM',
      'MemoryNotifier',
      'MemoryPrincipalStore',
      'MemoryScheduler',
      'createMemoryHost',
    ],
    classes: [
      'MemoryAtomStore',
      'MemoryAuditor',
      'MemoryCanonStore',
      'MemoryClock',
      'MemoryLLM',
      'MemoryNotifier',
      'MemoryPrincipalStore',
      'MemoryScheduler',
    ],
  },
  {
    subpath: '/adapters/file',
    mod: fileAdapter,
    expected: [
      'FileAtomStore',
      'FileAuditor',
      'FileCanonStore',
      'FileClock',
      'FileNotifier',
      'FilePrincipalStore',
      'FileScheduler',
      'createFileHost',
    ],
    classes: [
      'FileAtomStore',
      'FileAuditor',
      'FileCanonStore',
      'FileClock',
      'FileNotifier',
      'FilePrincipalStore',
      'FileScheduler',
    ],
  },
  {
    subpath: '/adapters/bridge',
    mod: bridgeAdapter,
    expected: ['BridgeAtomStore', 'createBridgeHost', 'dumpDrawers'],
    classes: ['BridgeAtomStore'],
  },
  {
    subpath: '/adapters/notifier',
    mod: notifierAdapter,
    expected: ['TelegramNotifier', 'parseCallbackData'],
    classes: ['TelegramNotifier'],
  },

  // /external and /lifecycle (no shim)
  {
    subpath: '/external/github',
    mod: githubExternal,
    expected: ['GhClientError', 'createGhClient', 'defaultGhExecutor'],
  },
  {
    subpath: '/external/github-app',
    mod: githubAppExternal,
    expected: [
      'InstallationTokenCache',
      'convertManifestCode',
      'createAppAuthedFetch',
      'createAppBackedGhClient',
      'createAppJwt',
      'createBranch',
      'fetchInstallationToken',
      'getBranchSha',
      'listAppInstallations',
      'openPullRequest',
      'upsertFile',
    ],
    classes: ['InstallationTokenCache'],
  },
  {
    subpath: '/lifecycle',
    mod: lifecycle,
    expected: ['ensureServiceRunning', 'getServiceStatus', 'stopService'],
  },
];

// Read subpaths straight from package.json so the regression "added
// a new export, forgot a row" fails here, not just the dual of
// "deleted a row". Set-equality is the honest contract for what
// this test name promises.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { exports: Record<string, unknown> };
// package.json keys are written as `./actors` etc; our rows carry
// the consumer-facing `/actors` form. Strip the leading `.` so the
// two compare cleanly.
const declaredSubpaths = Object.keys(pkg.exports)
  .filter((k) => k !== '.')
  .map((k) => k.replace(/^\./, ''))
  .sort();

describe('public surface: case coverage', () => {
  it('covers every non-root subpath from package.json#exports', () => {
    expect(cases.map((c) => c.subpath).sort()).toEqual(declaredSubpaths);
  });

  it('has no duplicate subpath rows', () => {
    const subpaths = cases.map((c) => c.subpath);
    expect(new Set(subpaths).size).toBe(subpaths.length);
  });
});

describe.each(cases)('public surface: $subpath subpath', ({ mod, real, expected, classes }) => {
  if (real !== undefined) {
    it('shim re-exports exactly the real barrel', () => {
      expect(Object.keys(mod).sort()).toEqual(Object.keys(real).sort());
    });
  }

  it('exports exactly the documented value surface', () => {
    expect(Object.keys(mod).sort()).toEqual([...expected].sort());
  });

  it('every documented value is defined', () => {
    for (const name of expected) {
      expect(mod[name], `${name} defined`).toBeDefined();
    }
  });

  if (classes && classes.length > 0) {
    it('every documented class is an ES6 class', () => {
      for (const name of classes) {
        // A plain function has `prototype` too, so prototype-defined
        // alone does not distinguish classes from factories. Anchor
        // on `prototype.constructor === fn` (true for both, so weak)
        // AND `toString().startsWith('class ')` (true only for ES6
        // class syntax). Together they fail a class-was-refactored-
        // into-a-factory regression.
        const fn = mod[name] as (new (...args: never[]) => unknown) | undefined;
        expect(fn, `${name} is defined`).toBeDefined();
        expect(typeof fn, `${name} typeof`).toBe('function');
        expect(fn?.prototype?.constructor, `${name}.prototype.constructor`).toBe(fn);
        expect(
          Function.prototype.toString.call(fn).startsWith('class '),
          `${name} declared via class keyword`,
        ).toBe(true);
      }
    });
  }
});
