/**
 * Unit tests for scripts/lib/autonomous-dispatch-exec.mjs.
 *
 * These pure helpers compose with execa inside the dispatch invoker
 * (scripts/invokers/autonomous-dispatch.mjs) to attach App-installation
 * auth to outgoing git commands without leaking the token through
 * argv. The invoker shells out, so the tests cover the load-bearing
 * shape guarantees rather than spawning a child:
 *
 *   - parseRepoSlug accepts only well-formed `owner/repo` strings.
 *   - looksLikeGitPush detects `push` verbs even when git-level `-c`
 *     options precede them (the upstream isPushCommand bails on
 *     non-flag args, so this guards the gap).
 *   - buildAuthedGitInvocation rewrites push argvs to a transient
 *     x-access-token URL and clears the credential helper.
 *   - buildAuthedGitInvocation routes read verbs through the
 *     Bearer extraHeader path the read-only env helper produces.
 *   - The caller-provided env wins over the inherited env, but the
 *     auth env wins over the caller env (a user override cannot
 *     accidentally re-enable a credential helper that would prompt).
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  EMBEDDED_ATOMS_HEADING,
  buildAuthedGitInvocation,
  looksLikeGitPush,
  parseEmbeddedAtomFromPrBody,
  parsePlanIdFromPrBody,
  parseRepoSlug,
  truncatePlanIdLabel,
} from '../../scripts/lib/autonomous-dispatch-exec.mjs';

const TOKEN = 'ghs_test_installation_token_0123456789';
const OWNER = 'stephengardner';
const REPO = 'layered-autonomous-governance';

// Pipeline-generated plan id observed in dogfeed-9 + dogfeed-11
// (2026-05-01): 91 chars long, overruns GitHub's 50-char label
// limit when prefixed with `plan-id:`. Lifted to module scope so
// every fixture using the same id flows through one source of
// truth (per dev-extract-at-n-equals-2 canon).
const LONG_PLAN_ID =
  'plan-add-one-line-pointer-to-docs-framework-m-cto-actor-pipeline-cto-1777622668718-vh8a0j-0';
// Sibling plan from the same multi-task pipeline; differs only at
// the trailing index suffix. Used to exercise hash-suffix collision
// avoidance.
const LONG_PLAN_ID_NEXT = LONG_PLAN_ID.replace(/-0$/, '-1');

describe('parseRepoSlug', () => {
  it('returns owner/repo for "owner/repo"', () => {
    expect(parseRepoSlug('foo/bar')).toEqual({ owner: 'foo', repo: 'bar' });
  });

  it('trims whitespace', () => {
    expect(parseRepoSlug('  foo/bar  ')).toEqual({ owner: 'foo', repo: 'bar' });
  });

  it('returns null for missing slash', () => {
    expect(parseRepoSlug('foobar')).toBe(null);
  });

  it('returns null for empty owner', () => {
    expect(parseRepoSlug('/bar')).toBe(null);
  });

  it('returns null for empty repo', () => {
    expect(parseRepoSlug('foo/')).toBe(null);
  });

  it('returns null for over-segmented input (rejects "org/team/repo" typos)', () => {
    // Regression for the truncate-on-extra-segments footgun: a
    // GH_REPO env typo like 'org/team/repo' must not silently
    // resolve to {owner:'org', repo:'team'} and dispatch against
    // the wrong repo with no diagnostic.
    expect(parseRepoSlug('org/team/repo')).toBe(null);
    expect(parseRepoSlug('a/b/c/d')).toBe(null);
  });

  it('returns null for non-string', () => {
    expect(parseRepoSlug(undefined)).toBe(null);
    expect(parseRepoSlug(null)).toBe(null);
    expect(parseRepoSlug(42 as unknown as string)).toBe(null);
  });
});

describe('truncatePlanIdLabel', () => {
  it('returns the full label when the plan id fits within 50 chars', () => {
    // Short legacy plan id (cto-actor + YYYYMMDDHHmmss form, 75
    // chars including the .json suffix => atom id is 70 chars).
    // 'plan-id:' + 'plan-x' => 14 chars: well under the cap.
    expect(truncatePlanIdLabel('plan-x')).toBe('plan-id:plan-x');
  });

  it('returns the full label when the combined length is exactly 50', () => {
    // 50-char total: 'plan-id:' (8) + plan id of length 42.
    const fortyTwoChars = 'a'.repeat(42);
    const out = truncatePlanIdLabel(fortyTwoChars);
    expect(out.length).toBe(50);
    expect(out).toBe(`plan-id:${fortyTwoChars}`);
  });

  it('truncates a plan id that overruns the 50-char limit by one byte', () => {
    // 51-char total: triggers the truncate path even though the
    // overflow is minimal. Hash-suffix shape becomes the canonical
    // form whenever truncation fires.
    const fortyThreeChars = 'b'.repeat(43);
    const out = truncatePlanIdLabel(fortyThreeChars);
    expect(out.length).toBe(50);
    expect(out.startsWith('plan-id:')).toBe(true);
    // Exactly 12 hex chars at the tail, separated by '-'.
    expect(/-[0-9a-f]{12}$/.test(out)).toBe(true);
  });

  it('truncates the dogfeed-9/-11 pipeline plan id to 50 chars', () => {
    const out = truncatePlanIdLabel(LONG_PLAN_ID);
    expect(out.length).toBe(50);
    expect(out.startsWith('plan-id:')).toBe(true);
    // Hash digest tail is the first 12 hex digits of sha256(planId).
    const expectedHash = createHash('sha256').update(LONG_PLAN_ID).digest('hex').slice(0, 12);
    expect(out.endsWith(`-${expectedHash}`)).toBe(true);
  });

  it('preserves the human-readable head of the plan id on truncation', () => {
    const out = truncatePlanIdLabel(LONG_PLAN_ID);
    // First 29 chars of the plan id appear right after `plan-id:`.
    // 50 - 8 (prefix) - 1 ('-') - 12 (hash) = 29.
    expect(out.slice(8, 8 + 29)).toBe(LONG_PLAN_ID.slice(0, 29));
  });

  it('disambiguates two plan ids that share a long prefix (multi-task plans)', () => {
    // Multi-task plans differ only at the trailing index suffix:
    // first-prefix truncation alone would collide on the same
    // 50-char label. The sha-256 digest tail is the
    // collision-avoidance mechanism the auditor relies on.
    const labelA = truncatePlanIdLabel(LONG_PLAN_ID);
    const labelB = truncatePlanIdLabel(LONG_PLAN_ID_NEXT);
    expect(labelA).not.toBe(labelB);
    expect(labelA.length).toBe(50);
    expect(labelB.length).toBe(50);
  });

  it('is deterministic: the same plan id always maps to the same label', () => {
    const out1 = truncatePlanIdLabel(LONG_PLAN_ID);
    const out2 = truncatePlanIdLabel(LONG_PLAN_ID);
    expect(out1).toBe(out2);
  });

  it('throws on empty input', () => {
    expect(() => truncatePlanIdLabel('')).toThrow();
  });

  it('throws on non-string input', () => {
    expect(() => truncatePlanIdLabel(undefined as unknown as string)).toThrow();
    expect(() => truncatePlanIdLabel(null as unknown as string)).toThrow();
    expect(() => truncatePlanIdLabel(42 as unknown as string)).toThrow();
  });

  it('round-trips for any plan id: truncate(planId) is the same regardless of who computes it', () => {
    // The auditor's PR-body-fallback path round-trips: it accepts a
    // body-derived plan id only when truncatePlanIdLabel(fromBody)
    // matches the workflow-supplied label token. This covers the
    // determinism contract that validation relies on -- the same
    // plan id always maps to the same label token, so a malicious
    // body that names a different plan would not satisfy the round
    // trip and would be rejected.
    expect(truncatePlanIdLabel(LONG_PLAN_ID)).toBe(truncatePlanIdLabel(LONG_PLAN_ID));
    expect(truncatePlanIdLabel(LONG_PLAN_ID)).not.toBe(truncatePlanIdLabel(LONG_PLAN_ID_NEXT));
  });
});

describe('parsePlanIdFromPrBody', () => {
  // Mirrors the YAML footer buildPrBody emits in
  // src/runtime/actors/code-author/pr-creation.ts:218-221. JSON.stringify
  // is the same encoding the source uses, so the test fixture
  // round-trips through whatever escape semantics the helper depends
  // on instead of a hand-quoted literal that could drift.
  const FOOTER_BODY = [
    '## Why',
    '',
    'Some prose explaining the change.',
    '',
    '## Machine-parseable provenance footer',
    '',
    '```yaml',
    `plan_id: ${JSON.stringify(LONG_PLAN_ID)}`,
    'observation_atom_id: "obs-12345"',
    'commit_sha: "abc1234567890"',
    '```',
  ].join('\n');

  it('extracts the full plan id from a buildPrBody-shaped footer', () => {
    expect(parsePlanIdFromPrBody(FOOTER_BODY)).toBe(LONG_PLAN_ID);
  });

  it('returns null when no plan_id field is present', () => {
    expect(parsePlanIdFromPrBody('## Why\n\nNo footer here.\n')).toBe(null);
  });

  it('returns null on null/undefined/non-string input', () => {
    expect(parsePlanIdFromPrBody(undefined)).toBe(null);
    expect(parsePlanIdFromPrBody(null)).toBe(null);
    expect(parsePlanIdFromPrBody('')).toBe(null);
    expect(parsePlanIdFromPrBody(42 as unknown as string)).toBe(null);
  });

  it('does not match a `plan_id` mention in surrounding prose (line-anchored)', () => {
    // A prose line like `the plan_id: "fake"` (note leading whitespace
    // / non-line-start position) must not capture; the YAML field is
    // anchored to a line beginning with multiline-flag.
    const body = 'See plan_id: "fake-id" in the prose.\nOther content.\n';
    expect(parsePlanIdFromPrBody(body)).toBe(null);
  });

  it('handles JSON-escaped characters (\\" \\\\ \\n) symmetrically with JSON.stringify', () => {
    // buildPrBody uses JSON.stringify on the plan id, so the parser
    // must handle the symmetric decode: an embedded quote round-trips
    // through escape -> capture -> JSON.parse. A plan id with literal
    // unusual chars is unlikely in practice but the contract is
    // 'parses what JSON.stringify produced'.
    const weirdId = 'plan-with-"quote"-and-\\backslash';
    const body = `plan_id: ${JSON.stringify(weirdId)}\nobservation_atom_id: "x"\n`;
    expect(parsePlanIdFromPrBody(body)).toBe(weirdId);
  });

  it('returns null on a malformed quoted value (missing closing quote)', () => {
    // Anchored regex requires the closing quote; a malformed line
    // returns null rather than emitting a half-decoded id that the
    // auditor would then fail to look up.
    const body = 'plan_id: "missing-end-quote\nobservation_atom_id: "x"\n';
    expect(parsePlanIdFromPrBody(body)).toBe(null);
  });
});

describe('parseEmbeddedAtomFromPrBody', () => {
  // Mirror the renderEmbeddedAtomBlock shape from
  // src/runtime/actors/code-author/pr-creation.ts so the test
  // fixture round-trips through whatever encoding the renderer
  // uses, instead of a hand-built literal that could drift.
  function buildBlock(atomId: string, payload: object | string): string {
    const json = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    return [
      `<details><summary>atom: ${atomId}</summary>`,
      '',
      '```json',
      json,
      '```',
      '',
      '</details>',
    ].join('\n');
  }

  function buildSection(blocks: ReadonlyArray<string>): string {
    return [EMBEDDED_ATOMS_HEADING, '', ...blocks].join('\n');
  }

  const PLAN_ID = LONG_PLAN_ID;
  const INTENT_ID = 'operator-intent-2026-04-30-fix-auditor';

  const PLAN_ATOM = {
    schema_version: 1,
    id: PLAN_ID,
    type: 'plan',
    layer: 'L1',
    principal_id: 'cto-actor',
    provenance: { kind: 'agent-claimed', source: { agent_id: 'cto-actor' }, derived_from: [INTENT_ID] },
    confidence: 0.9,
    scope: 'project',
    content: 'plan content',
    metadata: { delegation: { sub_actor_principal_id: 'code-author' } },
    created_at: '2026-04-30T12:00:00.000Z',
    last_reinforced_at: '2026-04-30T12:00:00.000Z',
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    taint: 'clean',
    signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
  };

  const INTENT_ATOM = {
    schema_version: 1,
    id: INTENT_ID,
    type: 'operator-intent',
    layer: 'L1',
    principal_id: 'apex-agent',
    provenance: { kind: 'human-attested', source: { author: 'apex-agent' }, derived_from: [] },
    confidence: 1,
    scope: 'project',
    content: 'fix the auditor ci gap',
    metadata: { trust_envelope: { max_blast_radius: 'tooling', min_plan_confidence: 0.7 } },
    created_at: '2026-04-30T11:00:00.000Z',
    last_reinforced_at: '2026-04-30T11:00:00.000Z',
    expires_at: '2026-05-30T11:00:00.000Z',
    supersedes: [],
    superseded_by: [],
    taint: 'clean',
    signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
  };

  it('extracts a single embedded atom snapshot keyed by id', () => {
    const body = buildSection([buildBlock(PLAN_ID, PLAN_ATOM)]);
    const out = parseEmbeddedAtomFromPrBody(body, PLAN_ID);
    expect(out).toMatchObject({ id: PLAN_ID, type: 'plan' });
  });

  it('extracts a sibling atom from a multi-block section', () => {
    // The renderer emits one <details> per snapshot in the same
    // section. The parser must scan each block and return the
    // first one whose JSON id matches the lookup, so a body that
    // ships {plan, intent} can resolve either id without a
    // surrounding-block ordering dependency.
    const body = buildSection([
      buildBlock(PLAN_ID, PLAN_ATOM),
      buildBlock(INTENT_ID, INTENT_ATOM),
    ]);
    expect(parseEmbeddedAtomFromPrBody(body, PLAN_ID)?.type).toBe('plan');
    expect(parseEmbeddedAtomFromPrBody(body, INTENT_ID)?.type).toBe('operator-intent');
  });

  it('returns null when the section heading is absent', () => {
    // A PR body that opens with prose but never emits the
    // embedded-atoms heading must not match a stray <details>
    // elsewhere; the heading is the section anchor.
    const body = `## Summary\n\nSome prose.\n\n${buildBlock(PLAN_ID, PLAN_ATOM)}\n`;
    expect(parseEmbeddedAtomFromPrBody(body, PLAN_ID)).toBe(null);
  });

  it('returns null when the requested atom id has no matching block', () => {
    const body = buildSection([buildBlock(PLAN_ID, PLAN_ATOM)]);
    expect(parseEmbeddedAtomFromPrBody(body, 'plan-other')).toBe(null);
  });

  it('rejects an id-mismatched payload (round-trip integrity guard)', () => {
    // Security regression: a block whose <summary> lies about its
    // atom id (claims plan-id-A but the JSON payload's `id` is
    // plan-id-B) MUST NOT pass the lookup for plan-id-A. The
    // parser compares the parsed payload's `id` field, not the
    // summary text. Without this gate a malicious PR-body edit
    // could redirect the auditor at an unrelated payload whose
    // envelope happens to permit the diff.
    const lyingBlock = [
      `<details><summary>atom: ${PLAN_ID}</summary>`,
      '',
      '```json',
      JSON.stringify({ ...PLAN_ATOM, id: 'plan-malicious' }, null, 2),
      '```',
      '',
      '</details>',
    ].join('\n');
    const body = buildSection([lyingBlock]);
    expect(parseEmbeddedAtomFromPrBody(body, PLAN_ID)).toBe(null);
  });

  it('skips a malformed JSON block and continues scanning', () => {
    // A truncated-JSON block (the renderer's
    // EMBEDDED_ATOM_JSON_CAP truncation marker produces this
    // shape) must not silently disable later valid blocks. A
    // body with one corrupt entry + one valid sibling still
    // surfaces the sibling.
    const body = buildSection([
      buildBlock(PLAN_ID, '{"id":"' + PLAN_ID + '","type":"plan",/* truncated */'),
      buildBlock(INTENT_ID, INTENT_ATOM),
    ]);
    expect(parseEmbeddedAtomFromPrBody(body, PLAN_ID)).toBe(null);
    expect(parseEmbeddedAtomFromPrBody(body, INTENT_ID)?.type).toBe('operator-intent');
  });

  it('returns null on null/undefined/empty body', () => {
    expect(parseEmbeddedAtomFromPrBody(undefined, PLAN_ID)).toBe(null);
    expect(parseEmbeddedAtomFromPrBody(null, PLAN_ID)).toBe(null);
    expect(parseEmbeddedAtomFromPrBody('', PLAN_ID)).toBe(null);
  });

  it('returns null on null/undefined/empty atom id', () => {
    const body = buildSection([buildBlock(PLAN_ID, PLAN_ATOM)]);
    expect(parseEmbeddedAtomFromPrBody(body, undefined)).toBe(null);
    expect(parseEmbeddedAtomFromPrBody(body, null)).toBe(null);
    expect(parseEmbeddedAtomFromPrBody(body, '')).toBe(null);
  });
});

describe('looksLikeGitPush', () => {
  it('detects push verb in a plain argv', () => {
    expect(looksLikeGitPush(['push', 'origin', 'main'])).toBe(true);
  });

  it('detects push verb when `-c k=v` precedes the verb', () => {
    expect(
      looksLikeGitPush([
        '-c', 'user.name=foo',
        '-c', 'user.email=bar@example.com',
        'push', 'origin', 'feat/x',
      ]),
    ).toBe(true);
  });

  it('returns false for read-only verbs', () => {
    expect(looksLikeGitPush(['fetch', 'origin', 'main'])).toBe(false);
    expect(
      looksLikeGitPush(['-c', 'user.name=foo', 'status', '--porcelain']),
    ).toBe(false);
  });

  it('returns false for non-array input', () => {
    expect(looksLikeGitPush(undefined as unknown as string[])).toBe(false);
    expect(looksLikeGitPush(null as unknown as string[])).toBe(false);
  });

  it('returns false for empty argv', () => {
    expect(looksLikeGitPush([])).toBe(false);
  });

  it('returns false when only flags are present and no verb is reachable', () => {
    expect(looksLikeGitPush(['-c', 'user.name=foo'])).toBe(false);
    expect(looksLikeGitPush(['-C', '/tmp/repo'])).toBe(false);
  });

  it('distinguishes the verb from a refspec named "push"', () => {
    // A benign `git fetch origin push` (refspec literally named
    // `push`) must not route into the push-auth path; positional
    // detection guards against the false positive a naive
    // `args.includes('push')` would emit.
    expect(looksLikeGitPush(['fetch', 'origin', 'push'])).toBe(false);
    expect(looksLikeGitPush(['-c', 'user.name=foo', 'fetch', 'origin', 'push'])).toBe(false);
  });

  it('handles `-C dir` and `--` separator', () => {
    expect(looksLikeGitPush(['-C', '/tmp/repo', 'push', 'origin', 'main'])).toBe(true);
    expect(looksLikeGitPush(['-C', '/tmp/repo', 'fetch', 'origin'])).toBe(false);
    // After `--`, the next arg is treated as the verb.
    expect(looksLikeGitPush(['--', 'push', 'origin', 'main'])).toBe(true);
  });
});

describe('buildAuthedGitInvocation', () => {
  it('push: rewrites the remote arg to an x-access-token URL', () => {
    const out = buildAuthedGitInvocation({
      args: ['push', 'origin', 'feat/x'],
      token: TOKEN,
      repoOwner: OWNER,
      repoName: REPO,
      inheritedEnv: { PATH: '/x' },
    });
    expect(out.args[0]).toBe('push');
    expect(out.args[1]).toBe(
      `https://x-access-token:${TOKEN}@github.com/${OWNER}/${REPO}.git`,
    );
    expect(out.args[2]).toBe('feat/x');
  });

  it('push: clears credential.helper and disables interactive prompt', () => {
    const out = buildAuthedGitInvocation({
      args: ['push', 'origin', 'feat/x'],
      token: TOKEN,
      repoOwner: OWNER,
      repoName: REPO,
      inheritedEnv: {},
    });
    expect(out.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(out.env.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(out.env.GIT_CONFIG_VALUE_0).toBe('');
    // GitHub receive-pack rejects Bearer auth: the http.extraHeader
    // entry that buildReadOnlyEnv emits must NOT appear on push.
    // Asserting the specific keys (not a substring scan) keeps the
    // test stable when env values legitimately contain the literal
    // word 'Bearer' for unrelated reasons.
    const envKeys = Object.keys(out.env);
    expect(envKeys.some((k) => out.env[k] === 'http.extraHeader')).toBe(false);
  });

  it('push: preserves `-c k=v` git-level options that precede the verb', () => {
    const out = buildAuthedGitInvocation({
      args: [
        '-c', 'user.name=foo',
        '-c', 'user.email=foo@example.com',
        'push', 'origin', 'feat/x',
      ],
      token: TOKEN,
      repoOwner: OWNER,
      repoName: REPO,
      inheritedEnv: {},
    });
    expect(out.args.slice(0, 4)).toEqual([
      '-c', 'user.name=foo',
      '-c', 'user.email=foo@example.com',
    ]);
    expect(out.args[4]).toBe('push');
    // Same transient URL pattern at the post-`-c` remote position.
    expect(out.args[5]).toContain(`x-access-token:${TOKEN}`);
  });

  it('local-only verb (rev-parse): keeps argv intact, applies the read-only env defensively', () => {
    // Pre-fix this test exercised `git fetch` against the read-only
    // path (Bearer extraHeader). After gap 7 the helper recognises
    // fetch as a remote-touching verb and rewrites the remote arg
    // to the x-access-token URL instead -- Bearer is rejected by
    // git's smart-http on Windows. Use a local-only verb here to
    // exercise the read-only env path that's still load-bearing
    // for non-remote git invocations the executor may emit
    // (rev-parse, status, log, config).
    const out = buildAuthedGitInvocation({
      args: ['rev-parse', '--abbrev-ref', 'HEAD'],
      token: TOKEN,
      repoOwner: OWNER,
      repoName: REPO,
      inheritedEnv: { PATH: '/x' },
    });
    expect(out.args).toEqual(['rev-parse', '--abbrev-ref', 'HEAD']);
    // buildReadOnlyEnv emits two GIT_CONFIG pairs (KEY_0/VALUE_0 +
    // KEY_1/VALUE_1) for http.extraHeader Bearer + cleared
    // credential.helper. Asserting the specific slots keeps the
    // test focused; upstream git-as-push-auth tests cover the
    // indexing convention.
    expect(out.env.GIT_CONFIG_COUNT).toBe('2');
    expect(out.env.GIT_CONFIG_KEY_0).toBe('http.extraHeader');
    expect(out.env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Bearer ${TOKEN}`);
    expect(out.env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('inherited env stays unless the auth env overrides the same key', () => {
    const out = buildAuthedGitInvocation({
      args: ['fetch', 'origin'],
      token: TOKEN,
      repoOwner: OWNER,
      repoName: REPO,
      inheritedEnv: { PATH: '/inherited', GIT_TERMINAL_PROMPT: '1' },
    });
    expect(out.env.PATH).toBe('/inherited');
    // Auth env wins on collision: the inherited '1' is stomped by '0'
    // so a misconfigured environment cannot re-enable the prompt.
    expect(out.env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('caller env layers between inherited and auth (auth wins on collision)', () => {
    const out = buildAuthedGitInvocation({
      args: ['fetch', 'origin'],
      token: TOKEN,
      repoOwner: OWNER,
      repoName: REPO,
      inheritedEnv: { A: 'inherited' },
      callerEnv: { A: 'caller', B: 'caller-only', GIT_TERMINAL_PROMPT: '1' },
    });
    expect(out.env.A).toBe('caller');
    expect(out.env.B).toBe('caller-only');
    // Auth env wins over caller env: a caller cannot re-enable the
    // prompt that buildReadOnlyEnv / buildPushEnv pin to '0'.
    // Regression guard: a future refactor that reordered the spread
    // to `{...buildReadOnlyEnv(token), ...callerEnv}` would silently
    // let an ambient askpass back in and hang the dispatch.
    expect(out.env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('buildAuthedGitInvocation: local-only verbs (status) need no auth and pass through unchanged', () => {
    // `git status --porcelain` is local-only -- no remote, no auth
    // needed. The helper should pass argv through and apply the
    // defensive read-only env (clears credential.helper, disables
    // tty prompt) without trying to rewrite anything.
    const out = buildAuthedGitInvocation({
      args: ['-c', 'user.name=foo', 'status', '--porcelain'],
      token: TOKEN,
      repoOwner: OWNER,
      repoName: REPO,
      inheritedEnv: {},
    });
    expect(out.args).toEqual(['-c', 'user.name=foo', 'status', '--porcelain']);
  });

  it('fetch verb: rewrites remote arg to x-access-token URL (gap-7 regression)', () => {
    // Gap 7 regression: pre-fix `git fetch` got the Bearer
    // extraheader treatment (buildReadOnlyEnv), but git's smart-http
    // protocol on Windows rejects Bearer for upload-pack and falls
    // through to the credential helper. With askpass disabled the
    // result is `error: unable to read askpass response from
    // git-askpass.exe / fatal: could not read Username for
    // 'https://github.com'`. URL-rewriting the remote-arg position
    // (matching the push path's auth method) is the only form that
    // works for git operations on both Windows and Linux.
    const out = buildAuthedGitInvocation({
      args: [
        '-c', 'user.name=foo',
        '-c', 'user.email=foo@example.com',
        'fetch', 'origin', 'main', '--quiet',
      ],
      token: TOKEN,
      repoOwner: OWNER,
      repoName: REPO,
      inheritedEnv: {},
    });
    // The remote name 'origin' (positional after the verb) is
    // replaced with the transient x-access-token URL.
    expect(out.args[5]).toBe(
      `https://x-access-token:${TOKEN}@github.com/${OWNER}/${REPO}.git`,
    );
    // verb + refspec + flag positions are preserved.
    expect(out.args[4]).toBe('fetch');
    expect(out.args[6]).toBe('main');
    expect(out.args[7]).toBe('--quiet');
    // Push-style env (clears credential.helper) -- ensures the
    // ambient git-askpass cannot pop up under any circumstance.
    expect(out.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(out.env.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(out.env.GIT_CONFIG_VALUE_0).toBe('');
  });

  it('clone verb: rewrites the URL positional when it matches the configured repo', () => {
    // For clone the positional after the verb is the remote URL,
    // not a remote name. The rewriter validates the URL points at
    // the dispatch-configured (owner, repo) before substituting the
    // transient x-access-token form; a matching URL is rewritten
    // to embed the token.
    const out = buildAuthedGitInvocation({
      args: ['clone', `https://github.com/${OWNER}/${REPO}.git`],
      token: TOKEN,
      repoOwner: OWNER,
      repoName: REPO,
      inheritedEnv: {},
    });
    expect(out.args[1]).toBe(
      `https://x-access-token:${TOKEN}@github.com/${OWNER}/${REPO}.git`,
    );
  });

  it('clone verb: leaves a non-target URL alone (no token leak to wrong repo)', () => {
    // A clone URL that does NOT match the configured (owner, repo)
    // falls through to the local-only branch (no rewrite, no
    // transient URL). This prevents the dispatch flow from
    // exfiltrating the access token to an arbitrary GitHub repo or
    // a non-GitHub host if a misconfigured caller smuggled in a
    // different URL.
    const out = buildAuthedGitInvocation({
      args: ['clone', 'https://github.com/foo/bar.git'],
      token: TOKEN,
      repoOwner: OWNER,
      repoName: REPO,
      inheritedEnv: {},
    });
    expect(out.args).toEqual(['clone', 'https://github.com/foo/bar.git']);
    // Read-only env still applied so any incidental remote call
    // does not pop askpass.
    expect(out.env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('fetch verb: leaves a non-origin remote name alone', () => {
    // `git fetch upstream main` should NOT silently retarget
    // OWNER/REPO; the rewrite is gated to 'origin' or matching
    // URL. The local-only path is the safer default.
    const out = buildAuthedGitInvocation({
      args: ['fetch', 'upstream', 'main'],
      token: TOKEN,
      repoOwner: OWNER,
      repoName: REPO,
      inheritedEnv: {},
    });
    expect(out.args).toEqual(['fetch', 'upstream', 'main']);
  });

  it('ls-remote: rewrites the remote arg', () => {
    const out = buildAuthedGitInvocation({
      args: ['ls-remote', 'origin'],
      token: TOKEN,
      repoOwner: OWNER,
      repoName: REPO,
      inheritedEnv: {},
    });
    expect(out.args[1]).toBe(
      `https://x-access-token:${TOKEN}@github.com/${OWNER}/${REPO}.git`,
    );
  });

  it('buildAuthedGitInvocation: bare push (no remote) is treated local-only', () => {
    // Bare `git push` without a remote position can't be rewritten;
    // the helper now treats this as a local-only verb (no remote
    // arg to point auth at) instead of throwing. The behaviour is
    // the safer default: the underlying git push will then fall
    // through to the configured upstream + credential helper, which
    // is the existing pre-fix behaviour for that argv shape.
    const out = buildAuthedGitInvocation({
      args: ['push'],
      token: TOKEN,
      repoOwner: OWNER,
      repoName: REPO,
      inheritedEnv: {},
    });
    expect(out.args).toEqual(['push']);
    // Read-only env still pinned (no askpass, no helper).
    expect(out.env.GIT_TERMINAL_PROMPT).toBe('0');
  });
});
