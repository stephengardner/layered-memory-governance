#!/usr/bin/env node
/**
 * gh-as: run a gh CLI command under a provisioned bot identity.
 *
 * Usage:
 *   node scripts/gh-as.mjs <role> <gh-args...>
 *
 * Examples:
 *   node scripts/gh-as.mjs lag-cto pr create --title "..." --body "..."
 *   node scripts/gh-as.mjs lag-pr-landing api repos/o/r/pulls/1/comments
 *
 * Mints a fresh installation token for <role> via gh-token-for.mjs,
 * sets it as GH_TOKEN in the child process environment, and execs
 * `gh <gh-args...>`. The child's stdout/stderr are piped through so
 * the caller sees gh's output verbatim.
 *
 * The token exists only for the duration of the child process;
 * it is not written to disk, not logged, and not inherited by the
 * parent shell. Each invocation is a fresh short-lived token (GitHub
 * Apps cap installation tokens at ~1 hour).
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  createCredentialsStore,
} from '../dist/actors/provisioning/index.js';
import {
  fetchInstallationToken,
} from '../dist/external/github-app/index.js';
import { createFileHost } from '../dist/adapters/file/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');

// Argv tokens that might carry secrets (tokens, passwords, keys). When
// one of these flags appears, the value immediately following it is
// redacted in the operator-action atom so the atom store never
// captures a secret. Narrow list by design; if we grow past this, the
// real fix is to stop letting secrets reach argv at all.
//
// Short flags intentionally omitted: `-t` clashes with `gh pr create
// --title` (aliased `-t`) and would destroy PR titles in the audit
// trail. The realistic token-leak surface for `gh api` is the
// Authorization header shape (-H "Authorization: bearer ..."), which
// is value-embedded and not captured by this simple flag-pair list;
// treat the argv-redaction as best-effort for obvious cases and rely
// on callers to avoid piping secrets through argv.
const REDACT_FLAG_NAMES = new Set([
  '--token', '--auth-token', '--github-token', '--access-token',
  '--api-key', '--password', '--secret',
]);

function redactSecretLikeArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    out.push(a);
    // Catch both `--flag value` and `--flag=value` shapes. The equals
    // form embeds the secret in the same token; we still redact it.
    if (typeof a === 'string' && a.includes('=')) {
      const idx = a.indexOf('=');
      const flag = a.slice(0, idx);
      if (REDACT_FLAG_NAMES.has(flag)) {
        out[out.length - 1] = `${flag}=<redacted>`;
      }
      continue;
    }
    if (REDACT_FLAG_NAMES.has(a) && i + 1 < args.length) {
      out.push('<redacted>');
      i++;
    }
  }
  return out;
}

async function main() {
  const role = process.argv[2];
  const ghArgs = process.argv.slice(3);
  if (!role || ghArgs.length === 0) {
    console.error('Usage: node scripts/gh-as.mjs <role> <gh-args...>');
    console.error('Example: node scripts/gh-as.mjs lag-cto pr create --title T --body B');
    process.exit(2);
  }

  const store = createCredentialsStore(STATE_DIR);
  const loaded = await store.load(role);
  if (loaded === null) {
    console.error(`[gh-as] no credentials for role '${role}'. Run: node bin/lag-actors.js sync`);
    process.exit(2);
  }
  if (loaded.record.installationId === undefined) {
    console.error(`[gh-as] role '${role}' provisioned but not installed on a repo.`);
    console.error(`Install: https://github.com/apps/${loaded.record.slug}/installations/new`);
    console.error(`Then:    node bin/lag-actors.js demo-pr --role ${role} --repo <owner/repo>`);
    process.exit(2);
  }

  // Wrap the mint in the same error shape as gh-token-for.mjs so
  // operators see one consistent `[gh-as] ...` one-liner on failure
  // instead of a raw V8 unhandled-rejection stack trace.
  let token;
  try {
    token = await fetchInstallationToken({
      appId: loaded.record.appId,
      privateKey: loaded.privateKey,
      installationId: loaded.record.installationId,
    });
  } catch (err) {
    console.error(`[gh-as] token mint failed: ${err?.message ?? err}`);
    process.exit(1);
  }

  // Atomize the operator action before exec. Every bot-identity-
  // mediated GitHub action produces an observation atom so the
  // provenance chain `operator -> agent -> bot -> GitHub op` has a
  // durable record. Without this, merges + comments + PR opens flow
  // through the bot identity with no atom trail, which is the
  // audit-gap closure described in `dev-atomize-operator-actions`
  // (canon). Redacted argv strips known secret-carrying flags. Best
  // effort: if the write fails we log and continue so an AtomStore
  // hiccup never blocks an operator action. Env override
  // LAG_SKIP_OPERATOR_ACTION_ATOM=1 disables the write for tests +
  // emergency bypass.
  const actionAtomId = await writeOperatorActionAtom(role, ghArgs);
  if (actionAtomId !== null) {
    // stderr, not stdout: callers frequently pipe gh output into JSON
    // parsers (`gh api ... | jq`, or passing into a Node consumer),
    // and any non-JSON line on stdout from the wrapper corrupts those
    // consumers. Observed in session 2026-04-21 when the audit-log
    // line broke a `gh api ... --method POST --input ...` PR-create
    // flow: Node tried to parse the stdout as JSON, hit the
    // `[gh-as] ...` prefix, and threw. Audit-log visibility is for
    // the operator watching the terminal; stderr is the right channel
    // for that, and keeps stdout contractually JSON-clean when gh's
    // own output is JSON. Also matches the rest of the wrapper's
    // logs (token mint, signal termination, failures) which already
    // use stderr.
    console.error(`[gh-as] operator-action atom ${actionAtomId}`);
  }

  // Exec gh with GH_TOKEN overridden for this child only. GH_TOKEN
  // beats any cached `gh auth` state; the parent shell is unaffected.
  //
  // shell:true ONLY on win32: the gh distribution on Windows ships as
  // a .cmd/.bat shim (gh.cmd, not gh.exe in every install). Node's
  // `spawn` with shell:false does NOT resolve .cmd/.bat via PATH, so
  // on Windows the invocation fails with ENOENT. shell:true hands the
  // lookup to cmd.exe which DOES resolve the shim. On Linux/macOS we
  // keep shell:false to avoid the shell-metacharacter injection
  // surface that shell:true would open up; the forwarded GH_TOKEN
  // argv is safe but user-passed args flow through unchecked.
  const isWindows = process.platform === 'win32';
  const child = spawn('gh', ghArgs, {
    env: {
      ...process.env,
      GH_TOKEN: token.token,
      // Defensive: some deployments have GITHUB_TOKEN set too.
      GITHUB_TOKEN: token.token,
    },
    stdio: 'inherit',
    shell: isWindows,
  });

  // A process can terminate two ways: normal exit (code is a number,
  // signal is null) or killed by a signal (code is null, signal is a
  // string like 'SIGTERM'). Forwarding only `code` here masked signal
  // terminations as exit 0; CI would treat a killed gh child as
  // success. Translate a signal termination to a non-zero exit so the
  // downstream check (GitHub Actions, make, shell && chain) fails
  // loudly. 128 + (Unix signal number) is the POSIX convention; we
  // don't have the signal number in Node's callback, so use a single
  // stable non-zero (1) with the signal name surfaced on stderr.
  child.on('exit', (code, signal) => {
    if (signal !== null) {
      console.error(`[gh-as] gh child terminated by signal ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 0);
  });
  child.on('error', (err) => {
    console.error(`[gh-as] failed to spawn gh: ${err?.message ?? err}`);
    process.exit(1);
  });
}

/**
 * Append an `operator-action` observation atom describing a
 * bot-identity-mediated GitHub op. Returns the atom id on success,
 * null on any failure (caller continues regardless; audit is
 * best-effort, the actual gh op is load-bearing).
 *
 * Shape:
 *   type:        'observation'
 *   layer:       'L1' (extracted observation, matching the
 *                agent-observed provenance kind; L0 would be raw
 *                pre-extraction which these are not)
 *   principal_id: the role (e.g., 'lag-ceo'); authority chain folds
 *                 through the bot identity, operator above, agent
 *                 below in the signed_by chain of the principals
 *                 registry.
 *   metadata.operator_action:
 *     { role, args, started_at, session_id, pid }
 *
 * Why 'observation' (not a new 'operator-action' type): using
 * an existing AtomType avoids a type-union widening for a single
 * script. If / when a second producer emits these (e.g., git-as-bot
 * wrappers), a dedicated type becomes justified.
 */
async function writeOperatorActionAtom(role, args) {
  if (process.env.LAG_SKIP_OPERATOR_ACTION_ATOM === '1') return null;

  const redactedArgs = redactSecretLikeArgs(args);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const pid = process.pid;
  const sessionId = process.env.LAG_SESSION_ID ?? `gh-as-${pid}-${randomUUID().slice(0, 8)}`;

  // ID needs to be unique across re-invocations AND stable within
  // one logical call. Includes wall-clock millisecond + pid + a
  // short uuid suffix so concurrent invocations don't collide, and
  // a retry of the same op produces a new audit entry intentionally
  // (a retry IS a distinct action).
  const id = `op-action-${role}-${nowMs}-${randomUUID().slice(0, 8)}`;

  const atom = {
    schema_version: 1,
    id,
    // JSON.stringify preserves argv boundaries faithfully so an
    // argument containing spaces (e.g., `--title "Land PR 53"`)
    // reads back as its original tokens instead of collapsing into
    // ambiguous whitespace. metadata.operator_action.args still
    // carries the array, but content should not silently lie about
    // what was invoked.
    content: `${role}: gh ${JSON.stringify(redactedArgs)}`,
    type: 'observation',
    // L1: agent-observed atoms land at the extracted layer per the
    // existing observation-contract (see
    // design/inbox-v1-load-test-commitment.md). L0 would mark this
    // as raw/untyped which would sit below the promotion pipeline's
    // aggregation queries.
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: {
        tool: 'gh-as',
        agent_id: role,
        session_id: sessionId,
      },
      derived_from: [],
    },
    confidence: 1.0,
    created_at: nowIso,
    last_reinforced_at: nowIso,
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
    principal_id: role,
    taint: 'clean',
    metadata: {
      operator_action: {
        role,
        args: redactedArgs,
        started_at: nowIso,
        session_id: sessionId,
        pid,
      },
    },
  };

  try {
    const host = await createFileHost({ rootDir: STATE_DIR });
    await host.atoms.put(atom);
    return id;
  } catch (err) {
    console.warn(`[gh-as] operator-action atom write failed: ${err?.message ?? err}`);
    return null;
  }
}

await main();
