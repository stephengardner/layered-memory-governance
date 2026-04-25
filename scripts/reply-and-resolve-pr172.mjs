#!/usr/bin/env node
// Reply inline to each CR thread on PR #172 and resolve it. Reads GH
// auth via gh-as. Per canon `feedback_detailed_coderabbit_replies`,
// each reply covers what changed (commit SHA + brief), why (rationale +
// trade-offs), and edge cases or follow-ups, BEFORE resolving.
import { execSync } from 'node:child_process';

const threads = [
  // ---- Finding 1 (Minor, docs:26 exit-code accuracy) --------------------
  {
    id: 'PRRT_kwDOSGhm9859nkyj',
    label: 'F1 (Minor) docs/cr-precheck.md:26 -- Exit codes line missing uncaught-exception path',
    body:
      'Fixed in 20bab77.\n\n'
      + '**What changed:** the Exit codes line in docs/cr-precheck.md '
      + 'now reads:\n\n'
      + '> Exit codes: `0` clean (or skipped on not-found, or empty diff), '
      + '`1` findings present (or CR CLI errored), `2` bad arguments OR an '
      + 'uncaught exception bubbled out of `main()` in '
      + '`scripts/cr-precheck.mjs` (e.g., unexpected runtime error, '
      + 'atom-write crash before the gate decision).\n\n'
      + '**Why fold both into 2 (vs split 2/3):**\n'
      + 'Splitting into a third exit code would change the contract '
      + 'the helper has with shells / CI runners that grep on '
      + '`exit code 2`. The two paths share an actionable signature '
      + '(operator must inspect stderr to disambiguate "wrong flag" '
      + 'from "main crashed"), so a single code with a doc-disclosed '
      + 'union is the cleaner contract. The `[cr-precheck] '
      + 'unexpected error:` prefix on the catch path (line 348) '
      + 'plus the bare-name `argv: unknown argument` prefix on the '
      + 'argv path keep the disambiguation cheap at the read.\n\n'
      + '**Edge case acknowledged:** an atom-write crash that '
      + 'happens AFTER the gate decision (e.g., the cli-error path '
      + 'tries to write the skip atom and the FileHost throws) '
      + 'would still bubble to the catch and exit 2, NOT 1. That is '
      + 'the right behavior: the gate already decided "block" but '
      + 'the audit failed to land, so the operator-visible signal '
      + 'is "something went wrong worse than the gate said." The '
      + 'atom-write inner try/catch (line 235) handles the '
      + 'common case of audit failure non-fatally; the catch in '
      + 'the runner is the floor.',
  },
  // ---- Finding 2 (Major, docs:72 contradicts CI workflow) ---------------
  {
    id: 'PRRT_kwDOSGhm9859nkyk',
    label: 'F2 (MAJOR) docs/cr-precheck.md:72 -- doc contradicts shipped CI behavior + unsafe branch-protection advice',
    body:
      'Fixed in 20bab77 using the suggested rewrite verbatim.\n\n'
      + '**What changed (lines 70-72):**\n'
      + '- Line 70 now states the workflow emits a loud `::warning::` '
      + 'and skips the install/verify/review steps (exit success), '
      + 'matching `.github/workflows/cr-precheck.yml:63-79` '
      + '(the `Check CODERABBIT_API_KEY presence` step + `if: '
      + 'steps.check_secret.outputs.secret_present == \'true\'` '
      + 'gates on the install/verify/review steps).\n'
      + '- Line 72 now warns operators: add `cr-precheck` to '
      + 'branch protection AFTER the secret lands, not before. '
      + 'Adding it earlier turns the gate into a green-by-default '
      + 'no-op (the silent-skip antipattern this whole helper '
      + 'exists to prevent).\n\n'
      + '**Why this finding earns Major (CR-correct severity):**\n'
      + 'This is the precise antipattern the canon directive '
      + '`feedback-cr-silent-skip-guards` is built to prevent: a '
      + 'gate that returns success when it cannot actually '
      + 'evaluate. An operator following the original line 72 '
      + 'guidance ("add to branch protection") before the secret '
      + 'lands would have a required check that says GREEN on '
      + 'every PR while the workflow is skipping the review step '
      + 'entirely. That is strictly worse than no gate -- the '
      + 'operator would believe CR is running and gating, when in '
      + 'reality the gate is inert. Catching this in review (vs '
      + 'shipping it) is the right call.\n\n'
      + '**Trade-off considered:** an alternative was to flip the '
      + 'workflow to FAIL on missing secret (so the doc is correct '
      + 'as originally written). Rejected: the workflow\'s '
      + 'progressive-enhancement posture ("inert-but-honest until '
      + 'the secret lands") matches the local helper\'s shape '
      + '(LOUD warning + skip atom on missing CLI). Failing the '
      + 'workflow on every PR until the secret is added would '
      + 'block all merges in the gap window, which is a worse '
      + 'operator experience than the doc-fix path. The doc fix '
      + 'aligns the contract with the (correct) implementation, '
      + 'and the branch-protection sequencing guidance closes the '
      + 'silent-skip vector at the operator-procedure layer.\n\n'
      + '**Edge case:** once the secret lands and the operator '
      + 'adds the check to branch protection, the workflow runs '
      + 'every PR and posts a real status -- the silent-skip '
      + 'window is closed structurally, not just by procedure. '
      + 'The new "Once the secret is configured" sentence makes '
      + 'this sequencing explicit so a future operator reading '
      + 'the doc cold knows the order: secret first, then '
      + 'branch-protection check.',
  },
  // ---- Finding 3 (Minor, scripts:314 signal-term gate hole) -------------
  {
    id: 'PRRT_kwDOSGhm9859nkyl',
    label: 'F3 (Minor) scripts/cr-precheck.mjs:314 -- signal-terminated CR CLI silently falls through to clean',
    body:
      'Fixed in 20bab77 via an extracted pure helper '
      + '`isCliErrorResult` (the suggested-diff approach was '
      + 'correct but I went one step further and pulled the '
      + 'classification into a unit-testable helper so future '
      + 'spawnSync-result branches can\'t silently regress).\n\n'
      + '**What changed:**\n'
      + '- New exported pure helper `isCliErrorResult(result)` '
      + 'returns true when ANY of: `result.error` (spawn-level '
      + 'failure: ENOENT, EACCES, explicit timeout), '
      + '`result.signal != null` (SIGTERM/SIGKILL/SIGINT/...), or '
      + 'numeric non-zero `result.status`. JSDoc spells out why '
      + 'each branch matters and pins the signal branch as the '
      + 'silent-skip vector being closed.\n'
      + '- `main()` line 299 now calls `isCliErrorResult(result)` '
      + 'instead of the inline status-only check. Inline comment '
      + 'at the call site names the signal-termination reason so '
      + 'a future reader looking only at `main()` sees why the '
      + 'helper exists.\n'
      + '- 7 new unit tests (`describe(\'isCliErrorResult\', ...)`) '
      + 'cover every classification branch:\n'
      + '  - clean exit (status 0, no signal, no error) -> '
      + 'runnable\n'
      + '  - non-zero numeric exit -> cli-error\n'
      + '  - SIGTERM-terminated -> cli-error (the regression case '
      + 'from your finding)\n'
      + '  - SIGKILL-terminated -> cli-error (signal-presence '
      + 'check, not signal-equality)\n'
      + '  - spawn-level error (ENOENT) -> cli-error\n'
      + '  - status===null with no signal and no error -> '
      + 'runnable (defensive fallback for a shape spawnSync does '
      + 'not produce in practice)\n'
      + '  - null/undefined input -> runnable (defensive against '
      + 'future callers)\n\n'
      + '**Why the helper-extraction over inline-fix:**\n'
      + 'Your suggested diff (`if (result.error || result.signal '
      + '|| (result.status !== null && result.status !== 0))`) '
      + 'is functionally equivalent and one fewer file. I chose '
      + 'the helper because:\n'
      + '- The classification is now a named contract (`isCliErrorResult`) '
      + 'rather than an inline boolean expression. A future '
      + 'reader scanning `main()` sees "is this a cli-error" '
      + 'instead of having to mentally evaluate the truth table.\n'
      + '- The unit-test surface is now seven explicit cases '
      + 'rather than zero (the inline form was untestable without '
      + 'spawning a real process or mocking spawnSync). Each case '
      + 'pins a specific spawnSync-result shape; if Node\'s '
      + 'documented behavior changes (e.g. AbortController '
      + 'integration in v22+), the failing test names which '
      + 'branch broke.\n'
      + '- The pure-helpers section already exports '
      + '`findCoderabbitOnPath`, `parseCrCliAgentFindings`, and '
      + '`decideExitCode` -- this fits the same shape ("orchestration '
      + 'is `main()`; classifiable decisions are pure exports").\n\n'
      + '**Edge case (defensive null/undefined branch):** '
      + 'spawnSync should not return null in practice (the docs '
      + 'guarantee an object with status/signal/error), but a '
      + 'future caller using `isCliErrorResult` on a wrapper '
      + 'shape could pass null/undefined accidentally. The '
      + 'defensive return-false is the right floor: a missing '
      + 'result is not "cli-error" (we have no evidence either '
      + 'way), and the upstream call site (`main()` already '
      + 'checked the spawnSync return is the result object) '
      + 'never feeds null in. The defensive behavior pins the '
      + 'contract for future reuse.\n\n'
      + '**Test result:** 25/25 tests pass (was 18; added 7 for '
      + 'the new `isCliErrorResult` describe block).',
  },
];

function ghApi(query, variables = {}) {
  const body = JSON.stringify({ query, variables });
  try {
    const out = execSync('node ../../scripts/gh-as.mjs lag-ceo api graphql --input -', {
      input: body,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(out.toString());
  } catch (err) {
    const stderr = err.stderr?.toString() ?? '';
    const stdout = err.stdout?.toString() ?? '';
    throw new Error(`gh-as graphql failed: ${stderr || stdout || err.message}`);
  }
}

let replied = 0;
let resolved = 0;
let failures = 0;

for (const t of threads) {
  console.log(`\n== ${t.label} ==`);

  const reply = ghApi(
    `mutation($threadId: ID!, $body: String!) {
       addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
         comment { id url }
       }
     }`,
    { threadId: t.id, body: t.body },
  );
  if (reply.errors) {
    console.error('reply errors:', JSON.stringify(reply.errors));
    failures += 1;
    continue;
  }
  console.log('replied:', reply.data.addPullRequestReviewThreadReply.comment.url);
  replied += 1;

  const res = ghApi(
    `mutation($threadId: ID!) {
       resolveReviewThread(input: { threadId: $threadId }) {
         thread { isResolved }
       }
     }`,
    { threadId: t.id },
  );
  if (res.errors) {
    console.error('resolve errors:', JSON.stringify(res.errors));
    failures += 1;
    continue;
  }
  console.log('resolved:', res.data.resolveReviewThread.thread.isResolved);
  resolved += 1;
}

console.log(`\n== summary ==\nreplied: ${replied}/${threads.length}\nresolved: ${resolved}/${threads.length}\nfailures: ${failures}`);
process.exit(failures > 0 ? 1 : 0);
