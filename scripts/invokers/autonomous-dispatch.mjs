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
import { join, resolve } from 'node:path';
import {
  buildAuthedGitInvocation,
  parseRepoSlug,
} from '../lib/autonomous-dispatch-exec.mjs';

export default async function register(host, registry) {
  const { runCodeAuthor } = await import('../../dist/runtime/actor-message/code-author-invoker.js');
  const { buildDefaultCodeAuthorExecutor } = await import('../../dist/runtime/actor-message/code-author-executor-default.js');
  const { createVirtualOrgGhClient } = await import('../../dist/examples/virtual-org-bootstrap/gh-client-factory.js');
  const { findIntentInProvenance } = await import('../../dist/runtime/actor-message/intent-approve.js');
  const { fetchInstallationToken } = await import('../../dist/external/github-app/app-auth.js');

  const role = process.env.LAG_DISPATCH_BOT_ROLE ?? 'lag-ceo';
  const repoDir = resolve(process.env.LAG_REPO_DIR ?? process.cwd());
  const stateDir = resolve(process.env.LAG_STATE_DIR ?? join(repoDir, '.lag'));
  const model = process.env.LAG_DRAFTER_MODEL ?? 'claude-sonnet-4-6';
  const baseBranch = process.env.GH_BASE_BRANCH ?? 'main';
  const remote = process.env.GH_REMOTE ?? 'origin';

  const { owner, repo } = await resolveOwnerRepo();

  const appRecord = loadAppRecord(role, stateDir);
  const privateKey = readFileSync(join(stateDir, 'apps', 'keys', `${role}.pem`), 'utf8');

  const ghClient = createVirtualOrgGhClient({ role, stateDir });
  const gitIdentity = {
    name: `${appRecord.slug}[bot]`,
    email: `${appRecord.appId}+${appRecord.slug}[bot]@users.noreply.github.com`,
  };

  const execImpl = buildBotAuthedExecImpl({
    fetchInstallationToken,
    appRecord,
    privateKey,
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
          await execa('node', [
            'scripts/gh-as.mjs', role,
            'api', `repos/${owner}/${repo}/issues/${capturedPrNumber}/labels`,
            '-X', 'POST',
            '-f', 'labels[]=autonomous-intent',
            '-f', `labels[]=plan-id:${capturedPlanId}`,
          ], { stdio: 'inherit' });
        } catch (err) {
          console.error(`[autonomous-dispatch] WARNING: failed to label PR #${capturedPrNumber}: ${err.message}. LAG-auditor gate will not fire until labels are added manually.`);
        }
      }
    }
    return result;
  });
}

async function resolveOwnerRepo() {
  const fromEnv = parseRepoSlug(process.env.GH_REPO);
  if (fromEnv) return fromEnv;
  const result = await execa('gh', ['repo', 'view', '--json', 'owner,name'], { reject: false });
  if (result.exitCode !== 0) {
    throw new Error(
      `[autonomous-dispatch] could not resolve owner/repo: set GH_REPO=owner/repo or run from a repo where 'gh repo view' works. stderr: ${result.stderr}`,
    );
  }
  const parsed = JSON.parse(result.stdout);
  return { owner: parsed.owner.login, repo: parsed.name };
}

function loadAppRecord(role, stateDir) {
  const recordPath = join(stateDir, 'apps', `${role}.json`);
  return JSON.parse(readFileSync(recordPath, 'utf8'));
}

/**
 * Build an `execImpl` for buildDefaultCodeAuthorExecutor that mints
 * a fresh installation token per call and attaches GitHub-App auth
 * to outgoing git commands. Non-git commands pass through unchanged.
 *
 * Token caching: a single mint per dispatch is sufficient (executor
 * runs in the order fetch -> commit -> push, all within seconds, and
 * an installation token is good for ~1h). We re-mint on each git call
 * for simplicity; if the executor ever batches a multi-PR run the
 * caller can replace this with a token cache without changing the
 * exec contract.
 */
function buildBotAuthedExecImpl({ fetchInstallationToken, appRecord, privateKey, repoOwner, repoName }) {
  return async (file, args, options = {}) => {
    if (file !== 'git') {
      return execa(file, args, options);
    }
    const tokenInfo = await fetchInstallationToken({
      appId: appRecord.appId,
      installationId: appRecord.installationId,
      privateKey,
    });
    const invocation = buildAuthedGitInvocation({
      args,
      token: tokenInfo.token,
      repoOwner,
      repoName,
      inheritedEnv: process.env,
      callerEnv: options.env ?? {},
    });
    return execa(file, invocation.args, { ...options, env: invocation.env });
  };
}
