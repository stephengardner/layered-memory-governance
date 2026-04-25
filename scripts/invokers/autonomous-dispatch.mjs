// scripts/invokers/autonomous-dispatch.mjs
/**
 * Dispatch-invoker registrar for run-approval-cycle --invokers <this-path>.
 * Registers `code-author` so plans whose delegation envelope names that
 * sub-actor route into the existing code-author drafter + git-ops +
 * pr-creation chain.
 *
 * Wiring resolved at register() time:
 *   - host:        passed in by run-approval-cycle (already file-backed)
 *   - ghClient:    App-backed via createVirtualOrgGhClient(role, stateDir)
 *   - owner/repo:  GH_REPO env (e.g. "owner/repo") or fallback `gh repo view`
 *   - repoDir:     LAG_REPO_DIR env or process.cwd()
 *   - gitIdentity: derived from <stateDir>/apps/<role>.json (the same
 *                  noreply identity GitHub minted for the App)
 *   - model:       LAG_DRAFTER_MODEL env, defaults to claude-sonnet-4-6
 *   - role:        LAG_DISPATCH_BOT_ROLE env, defaults to 'lag-ceo'
 *                  (the role that already lands code-author PRs in this
 *                  instance; consumers can swap to a dedicated
 *                  'lag-code-author' role by provisioning it + setting
 *                  the env var).
 *
 * Git push auth: code-author's apply-branch step shells out to git
 * directly, so the dispatch wrapper supplies an `execImpl` that
 * mints an installation token from the on-disk App record and either
 *   - rewrites `git push <remote>` to a transient x-access-token URL
 *     with the token in the userinfo position (write verbs), or
 *   - injects an `http.extraHeader: Authorization: Bearer <token>`
 *     via GIT_CONFIG_* env (read verbs).
 * Both paths reuse the helpers in scripts/lib/git-as-push-auth.mjs
 * so the auth shape matches what bare `git-as` does on the operator
 * side.
 *
 * After a successful dispatch the wrapper applies `autonomous-intent`
 * and `plan-id:<id>` labels to the new PR. Those labels key the
 * pr-landing workflow's LAG-auditor gate; without them, once the
 * branch-protection migration runs every intent-driven PR would hang
 * on a never-posted required status.
 */
import { execa } from 'execa';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAuthedGitInvocation,
  parseRepoSlug,
} from '../lib/autonomous-dispatch-exec.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GH_AS_PATH = resolve(HERE, '..', 'gh-as.mjs');

export default async function register(host, registry) {
  const { runCodeAuthor } = await import('../../dist/runtime/actor-message/code-author-invoker.js');
  const { buildDefaultCodeAuthorExecutor } = await import('../../dist/runtime/actor-message/code-author-executor-default.js');
  const { createVirtualOrgGhClient } = await import('../../dist/examples/virtual-org-bootstrap/gh-client-factory.js');
  const { findIntentInProvenance } = await import('../../dist/runtime/actor-message/intent-approve.js');
  const { InstallationTokenCache } = await import('../../dist/external/github-app/app-auth.js');

  // LAG_DISPATCH_BOT_ROLE is required: defaulting to a specific
  // principal id (e.g. 'lag-ceo') in the canonical invoker would
  // bake this org's principal taxonomy into framework-adjacent
  // code; downstream consumers would inherit the default unless
  // they remembered to set the env var on every run. Mirrors the
  // bootstrap-script discipline for LAG_OPERATOR_ID. Operators
  // wire their own role at deployment time.
  const role = process.env.LAG_DISPATCH_BOT_ROLE;
  if (typeof role !== 'string' || role.trim().length === 0) {
    throw new Error(
      '[autonomous-dispatch] LAG_DISPATCH_BOT_ROLE is required. '
      + 'Set it to the bot role whose App credentials live at '
      + '<stateDir>/apps/<role>.json (provisioned via bin/lag-actors.js).',
    );
  }
  const repoDir = resolve(process.env.LAG_REPO_DIR ?? process.cwd());
  const stateDir = resolve(process.env.LAG_STATE_DIR ?? join(repoDir, '.lag'));
  const model = process.env.LAG_DRAFTER_MODEL ?? 'claude-sonnet-4-6';
  const baseBranch = process.env.GH_BASE_BRANCH ?? 'main';
  const remote = process.env.GH_REMOTE ?? 'origin';

  const { owner, repo } = await resolveOwnerRepo();

  const appRecord = loadAppRecord(role, stateDir);
  const privateKey = readFileSync(join(stateDir, 'apps', 'keys', `${role}.pem`), 'utf8');

  const ghClient = createVirtualOrgGhClient({ role, stateDir });

  // GitHub mints the bot's noreply address as
  // `<bot-user-id>+<slug>[bot]@users.noreply.github.com`, where
  // <bot-user-id> is the User ID GitHub assigns the App's bot
  // principal (NOT the App ID, which is a different number used to
  // sign JWTs). Fetch the bot user id from the public /users/<slug>[bot]
  // endpoint when the on-disk record does not carry it; persist on
  // the closure so subsequent calls reuse it. boot.mjs has the same
  // pattern; a follow-up will add `botUserId` to the record schema
  // so the GET round-trip is one-time.
  const botUserId = appRecord.botUserId ?? await fetchBotUserId(appRecord.slug);
  const gitIdentity = {
    name: `${appRecord.slug}[bot]`,
    email: `${botUserId}+${appRecord.slug}[bot]@users.noreply.github.com`,
  };

  // InstallationTokenCache (shared with src/external/github-app/) lazily
  // refreshes the App-installation token within a configurable safety
  // margin before expiry, so multiple git invocations per dispatch (fetch
  // + apply + commit + push) reuse one token. Replaces an earlier
  // closure that minted on every git call -- redundant JWT signs and
  // installation-token API hits push toward GitHub's rate limit.
  const tokenCache = new InstallationTokenCache({
    appId: appRecord.appId,
    installationId: appRecord.installationId,
    privateKey,
  });

  const execImpl = buildBotAuthedExecImpl({
    tokenCache,
    repoOwner: owner,
    repoName: repo,
  });

  const defaultExecutor = buildDefaultCodeAuthorExecutor({
    host,
    ghClient,
    owner,
    repo,
    repoDir,
    gitIdentity,
    model,
    remote,
    baseBranch,
    execImpl,
  });

  registry.register('code-author', async (payload, correlationId) => {
    let capturedPrNumber = null;
    let capturedPlanId = null;
    const wrappedExecutor = {
      async execute(inputs) {
        capturedPlanId = String(inputs.plan.id);
        const execResult = await defaultExecutor.execute(inputs);
        if (execResult.kind === 'dispatched') {
          capturedPrNumber = execResult.prNumber;
        }
        return execResult;
      },
    };

    const result = await runCodeAuthor(host, payload, correlationId, { executor: wrappedExecutor });

    if (result.kind === 'dispatched' && capturedPrNumber !== null && capturedPlanId !== null) {
      const plan = await host.atoms.get(capturedPlanId);
      const intentId = plan ? await findIntentInProvenance(host, plan) : null;
      if (intentId) {
        try {
          // Resolve gh-as.mjs against this invoker's location and run
          // it with cwd=repoDir so the spawn works whether the
          // approval-cycle CLI was invoked from the repo root or
          // from elsewhere via LAG_REPO_DIR. A relative path here
          // would silently swallow into the catch below and disable
          // the LAG-auditor label flow without operator visibility.
          await execa('node', [
            GH_AS_PATH, role,
            'api', `repos/${owner}/${repo}/issues/${capturedPrNumber}/labels`,
            '-X', 'POST',
            '-f', 'labels[]=autonomous-intent',
            '-f', `labels[]=plan-id:${capturedPlanId}`,
          ], { stdio: 'inherit', cwd: repoDir });
        } catch (err) {
          const cause = err instanceof Error ? err.message : String(err);
          console.error(`[autonomous-dispatch] WARNING: failed to label PR #${capturedPrNumber}: ${cause}. LAG-auditor gate will not fire until labels are added manually.`);
        }
      }
    }
    return result;
  });
}

async function resolveOwnerRepo() {
  const fromEnv = parseRepoSlug(process.env.GH_REPO);
  if (fromEnv) return fromEnv;
  // execa with reject:false suppresses non-zero exits but still
  // throws ENOENT when the binary is absent. Catch the spawn error
  // explicitly so a host without the gh CLI gets the same actionable
  // diagnostic as a host where `gh repo view` runs but exits non-zero.
  let result;
  try {
    result = await execa('gh', ['repo', 'view', '--json', 'owner,name'], { reject: false });
  } catch (err) {
    throw new Error(
      `[autonomous-dispatch] could not resolve owner/repo: set GH_REPO=owner/repo or install the gh CLI. cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `[autonomous-dispatch] could not resolve owner/repo: set GH_REPO=owner/repo or run from a repo where 'gh repo view' works. stderr: ${result.stderr}`,
    );
  }
  const parsed = JSON.parse(result.stdout);
  if (!parsed?.owner?.login || !parsed?.name) {
    throw new Error(
      `[autonomous-dispatch] gh repo view returned an unexpected JSON shape; cannot resolve owner/repo from: ${result.stdout}`,
    );
  }
  return { owner: parsed.owner.login, repo: parsed.name };
}

function loadAppRecord(role, stateDir) {
  const recordPath = join(stateDir, 'apps', `${role}.json`);
  return JSON.parse(readFileSync(recordPath, 'utf8'));
}

/**
 * Resolve the bot user id GitHub minted for an App installation by
 * calling the public /users/<slug>[bot] endpoint. Read-only; no
 * authentication needed. The id is what the noreply email format
 * (`<botUserId>+<slug>[bot]@users.noreply.github.com`) requires --
 * appId is a different number used to sign JWTs and produces a
 * syntactically valid email that GitHub will not link back to the
 * bot's user page.
 */
async function fetchBotUserId(slug) {
  const url = `https://api.github.com/users/${slug}[bot]`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'lag-autonomous-dispatch',
    },
  });
  if (!res.ok) {
    throw new Error(
      `[autonomous-dispatch] could not fetch bot user id for slug='${slug}'. `
      + `${url} -> ${res.status} ${res.statusText}. `
      + `Persist 'botUserId' on the App record under <stateDir>/apps/<role>.json `
      + 'to skip this round-trip on future runs.',
    );
  }
  const json = await res.json();
  if (typeof json.id !== 'number') {
    throw new Error(
      `[autonomous-dispatch] /users/${slug}[bot] returned an unexpected shape (no numeric id): ${JSON.stringify(json).slice(0, 200)}`,
    );
  }
  return json.id;
}

/**
 * Build an `execImpl` for buildDefaultCodeAuthorExecutor that
 * attaches GitHub-App installation auth to outgoing git commands.
 * Non-git commands pass through unchanged. Token reuse is delegated
 * to the InstallationTokenCache instance the caller passes in;
 * cache.get() returns the current token (refreshed lazily within
 * the cache's safety margin before expiry).
 */
function buildBotAuthedExecImpl({ tokenCache, repoOwner, repoName }) {
  return async (file, args, options = {}) => {
    if (file !== 'git') {
      return execa(file, args, options);
    }
    const token = await tokenCache.get();
    const invocation = buildAuthedGitInvocation({
      args,
      token,
      repoOwner,
      repoName,
      inheritedEnv: process.env,
      callerEnv: options.env ?? {},
    });
    return execa(file, invocation.args, { ...options, env: invocation.env });
  };
}
