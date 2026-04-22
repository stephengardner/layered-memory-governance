#!/usr/bin/env node
/**
 * lag-actors CLI.
 *
 * Subcommands:
 *   sync         Walk roles.json. For each un-provisioned actor, open
 *                a browser to approve App creation, then store creds.
 *                High-risk roles ask for Telegram approval first.
 *   list         Show all provisioned actors and their App identities.
 *   demo-pr      Open a trivial test PR as a provisioned actor (proves
 *                the full chain works end-to-end).
 */

import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import {
  loadRoleRegistry,
  findRole,
  provisionRole,
  createCredentialsStore,
} from '../dist/runtime/actors/provisioning/index.js';
import {
  createAppAuthedFetch,
  listAppInstallations,
  openPullRequest,
  getBranchSha,
  createBranch,
  upsertFile,
  createAppBackedGhClient,
} from '../dist/external/github-app/index.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');
const CWD = process.cwd();

async function loadDotEnv() {
  const path = resolve(CWD, '.env');
  if (!existsSync(path)) return;
  try {
    const text = await readFile(path, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch { /* optional */ }
}

function parseArgs(argv) {
  const args = {
    command: argv[0] ?? 'help',
    role: null,
    repo: null, // owner/repo
    rolesPath: resolve(CWD, 'roles.json'),
    stateDir: resolve(CWD, '.lag'),
    nonInteractive: false,
    json: false,
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--role' && i + 1 < argv.length) args.role = argv[++i];
    else if (a === '--repo' && i + 1 < argv.length) args.repo = argv[++i];
    else if (a === '--roles' && i + 1 < argv.length) args.rolesPath = resolve(CWD, argv[++i]);
    else if (a === '--state-dir' && i + 1 < argv.length) args.stateDir = resolve(CWD, argv[++i]);
    else if (a === '--non-interactive') args.nonInteractive = true;
    else if (a === '--json') args.json = true;
    else if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: lag-actors <command> [options]

Commands:
  sync                 Provision GitHub App identities for every actor
                       in roles.json that has no credentials yet.
  list                 Show provisioned actors.
  demo-pr              Open a trivial test PR as an actor to prove
                       end-to-end auth. Requires --role and --repo.
  demo-adapter         Exercise the GhClient adapter (rest + graphql)
                       against GitHub to confirm the pluggable auth
                       backend works. Requires --role.
  help                 This help.

Options:
  --role <name>        Target a specific actor (for demo-pr, sync --role).
  --repo <owner/repo>  Target repo for demo-pr (e.g. stephengardner/foo).
  --roles <path>       Path to roles.json (default: ./roles.json).
  --state-dir <path>   Directory for .lag/apps/ state (default: ./.lag).
  --non-interactive    Never prompt; fail if high-risk role needs approval.
  --json               Machine-readable output.
`);
}

async function openBrowserCmd(url) {
  const cmd = process.platform === 'win32'
    ? ['cmd.exe', ['/c', 'start', '""', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  return new Promise((resolveFn, rejectFn) => {
    const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true });
    child.on('error', rejectFn);
    child.unref();
    setTimeout(() => resolveFn(), 200);
  });
}

/**
 * High-risk approval. Resolution order:
 *   1. LAG_AUTO_APPROVE_HIGH_RISK=1 auto-approves (scripted / CI flows).
 *   2. stdin is a TTY -> prompt y/N.
 *   3. stdin not a TTY and no env flag -> reject (fail-closed).
 */
async function approveHighRiskInteractive(role, risk) {
  console.log('');
  console.log(`[HIGH-RISK] Role '${role.name}' wants:`);
  for (const reason of risk.reasons) console.log(`  - ${reason}`);
  console.log('');

  if (process.env.LAG_AUTO_APPROVE_HIGH_RISK === '1') {
    console.log(`[${role.name}] auto-approving via LAG_AUTO_APPROVE_HIGH_RISK=1`);
    return true;
  }

  if (!process.stdin.isTTY) {
    console.log(`[${role.name}] stdin is not a TTY and LAG_AUTO_APPROVE_HIGH_RISK is not set; rejecting`);
    return false;
  }

  process.stdout.write('Approve provisioning? [y/N] ');
  const answer = await new Promise((resolveFn) => {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (data) => {
      process.stdin.pause();
      resolveFn(String(data).trim().toLowerCase());
    });
  });
  return answer === 'y' || answer === 'yes';
}

async function cmdSync(args) {
  await loadDotEnv();
  const registry = await loadRoleRegistry(args.rolesPath);
  const store = createCredentialsStore(args.stateDir);

  const targets = args.role
    ? registry.actors.filter((a) => a.name === args.role)
    : registry.actors;
  if (targets.length === 0) {
    console.error(`No actor named '${args.role}' in ${args.rolesPath}`);
    process.exit(1);
  }

  const outcomes = [];
  for (const role of targets) {
    const out = await provisionRole({
      role,
      store,
      approveHighRisk: args.nonInteractive
        ? async () => false
        : approveHighRiskInteractive,
      openBrowser: openBrowserCmd,
      log: (line) => console.log(line),
    });
    outcomes.push(out);
    if (out.kind === 'failed') {
      console.error(`[${role.name}] FAIL: ${out.error}`);
    }
  }

  if (args.json) console.log(JSON.stringify(outcomes, null, 2));
  const failures = outcomes.filter((o) => o.kind === 'failed').length;
  process.exit(failures > 0 ? 2 : 0);
}

async function cmdList(args) {
  const store = createCredentialsStore(args.stateDir);
  const records = await store.list();
  if (args.json) {
    console.log(JSON.stringify(records, null, 2));
    return;
  }
  if (records.length === 0) {
    console.log('No provisioned actors under', args.stateDir);
    return;
  }
  for (const r of records) {
    const install = r.installationId ? ` installed(${r.installationId})` : ' (not installed)';
    console.log(`${r.role.padEnd(24)}  ${r.slug}[bot]  app=${r.appId}  owner=${r.owner}${install}`);
  }
}

async function cmdDemoPr(args) {
  if (!args.role || !args.repo) {
    console.error('demo-pr requires --role <name> and --repo <owner/repo>');
    process.exit(1);
  }
  const [owner, repo] = args.repo.split('/');
  if (!owner || !repo) {
    console.error(`--repo must be in the form owner/repo, got: ${args.repo}`);
    process.exit(1);
  }

  const store = createCredentialsStore(args.stateDir);
  const loaded = await store.load(args.role);
  if (!loaded) {
    console.error(`no credentials for role '${args.role}'. Run 'lag-actors sync' first.`);
    process.exit(1);
  }
  const { record, privateKey } = loaded;

  let installationId = record.installationId;
  if (!installationId) {
    const installs = await listAppInstallations({ appId: record.appId, privateKey });
    const match = installs.find((i) => i.account.login.toLowerCase() === owner.toLowerCase());
    if (!match) {
      console.error(`App ${record.slug} is not installed on '${owner}'. Install it via the App's settings page in GitHub, then retry.`);
      console.error(`Installation page: https://github.com/apps/${record.slug}/installations/new`);
      process.exit(1);
    }
    installationId = match.id;
    record.installationId = installationId;
    await store.update(record);
    console.log(`[${args.role}] recorded installationId=${installationId}`);
  }

  const appFetch = createAppAuthedFetch({
    appId: record.appId,
    privateKey,
    installationId,
  });

  // Resolve the repo's actual default branch. Hardcoding 'main' breaks
  // on any repo that still uses 'master' or a custom default.
  const repoRes = await appFetch(`/repos/${owner}/${repo}`);
  if (!repoRes.ok) {
    const body = await repoRes.text();
    console.error(`get repo failed: ${repoRes.status} ${body}`);
    process.exit(1);
  }
  const base = (await repoRes.json()).default_branch;
  const branch = `lag-actor-demo-${record.slug}-${Date.now()}`;
  const baseSha = await getBranchSha({ fetch: appFetch, owner, repo, branch: base });
  await createBranch({ fetch: appFetch, owner, repo, branch, fromSha: baseSha });
  console.log(`[${args.role}] created branch ${branch} from ${base}@${baseSha.slice(0, 8)}`);

  const filePath = `docs/actors/${record.slug}-hello.md`;
  const content = `# Hello from ${record.slug}\n\nThis PR was opened by the LAG actor '${args.role}' as a proof-of-life test.\n\nCreated at: ${new Date().toISOString()}\n`;
  const { sha } = await upsertFile({
    fetch: appFetch,
    owner,
    repo,
    path: filePath,
    branch,
    content,
    message: `actors/${args.role}: demo PR hello world`,
  });
  console.log(`[${args.role}] committed ${filePath}@${sha.slice(0, 8)} on ${branch}`);

  const pr = await openPullRequest({
    fetch: appFetch,
    owner,
    repo,
    title: `[actor-demo] ${record.slug} end-to-end proof of life`,
    body: `This PR was opened by the \`${record.slug}[bot]\` identity provisioned via LAG Actor provisioning.\n\nIf you see this PR authored by \`${record.slug}[bot]\`, the full flow works: manifest URL -> callback -> credentials -> JWT -> installation token -> Contents API + Pulls API.\n\nSafe to close. No merge intended.\n`,
    head: branch,
    base,
  });
  console.log(`[${args.role}] opened PR: ${pr.url}`);
  if (args.json) {
    console.log(JSON.stringify({
      role: args.role,
      slug: record.slug,
      branch,
      prNumber: pr.number,
      prUrl: pr.url,
    }, null, 2));
  }
}

async function cmdDemoAdapter(args) {
  if (!args.role) {
    console.error('demo-adapter requires --role <name>');
    process.exit(1);
  }
  const store = createCredentialsStore(args.stateDir);
  const loaded = await store.load(args.role);
  if (!loaded) {
    console.error(`no credentials for role '${args.role}'. Run 'lag-actors sync' first.`);
    process.exit(1);
  }
  const { record, privateKey } = loaded;
  if (!record.installationId) {
    console.error(`role '${args.role}' has no installationId yet. Run 'lag-actors demo-pr' once against a repo first to record it, or install the App manually.`);
    process.exit(1);
  }

  // Build a GhClient that authenticates as the App bot. Any actor
  // written against GhClient (including PrLandingActor via
  // GitHubPrReviewAdapter) can consume this client unchanged.
  const client = createAppBackedGhClient({
    auth: {
      appId: record.appId,
      privateKey,
      installationId: record.installationId,
    },
  });

  // Surface 1: REST. /installation/repositories is the canonical
  // "what can I see?" call for an App installation.
  const repos = await client.rest({
    path: '/installation/repositories',
    query: { per_page: 5 },
  });
  const repoNames = (repos?.repositories ?? []).map((r) => r.full_name);
  console.log(`[${args.role}] rest /installation/repositories -> ${repoNames.length} repo(s):`);
  for (const n of repoNames) console.log(`  - ${n}`);

  // Surface 2: GraphQL. viewer.login returns the bot's own identity.
  const viewer = await client.graphql(
    'query { viewer { login __typename } }',
  );
  console.log(`[${args.role}] graphql { viewer { login } } -> ${viewer.viewer.login} (${viewer.viewer.__typename})`);

  if (args.json) {
    console.log(JSON.stringify({
      role: args.role,
      bot: viewer.viewer.login,
      repos: repoNames,
    }, null, 2));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case 'sync':
      await cmdSync(args);
      break;
    case 'list':
      await cmdList(args);
      break;
    case 'demo-pr':
      await cmdDemoPr(args);
      break;
    case 'demo-adapter':
      await cmdDemoAdapter(args);
      break;
    case 'help':
    default:
      printHelp();
      break;
  }
}

main().catch((err) => {
  console.error('lag-actors failed:', err?.stack ?? err);
  process.exit(1);
});
