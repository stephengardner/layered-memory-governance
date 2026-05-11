#!/usr/bin/env node
/**
 * Setup local git config for this repo.
 *
 * Why this exists
 * ---------------
 * On Windows, `git` consults the platform credential helper (Git
 * Credential Manager) whenever a network op needs auth and nothing
 * is cached for the requested remote. GCM opens a GUI sign-in dialog
 * that hangs the script with no TTY signal. The dialog is unwelcome
 * during automation runs and has surfaced as a recurring popup the
 * operator wants eliminated at the substrate floor.
 *
 * The clean fix is to disable the credential helper at the
 * repository-local config level. After running this once:
 *
 *   - Every `git` invocation in this repo (and every worktree, since
 *     worktrees share .git) skips GCM entirely.
 *   - Token-bearing ops continue to work because `scripts/git-as.mjs`
 *     and `scripts/lib/git-spawn-no-prompt.mjs` inject explicit
 *     credentials per-invocation (transient URL, http.extraHeader).
 *   - Ops that genuinely need cached credentials fail fast with a
 *     clean auth error instead of hanging on a GUI dialog.
 *
 * The setting is repo-local (not global), so other repos on the same
 * machine keep their normal credential-helper behavior. It is
 * idempotent: running multiple times leaves a single empty-helper
 * pair in `.git/config`.
 *
 * Run path
 * --------
 * Wired into the `prepare` lifecycle hook in package.json so
 * `npm install` applies it automatically on fresh clones. Operators
 * can also run it directly: `node scripts/setup-local-git-config.mjs`.
 *
 * Substrate posture: this matches the canon directive that every
 * GitHub-visible action MUST go through a bot-identity wrapper
 * (`git-as.mjs lag-ceo`). With the credential helper cleared, the
 * only way `git` can succeed at a network op is via an explicitly
 * injected token, which IS the wrapper path. Operators who try a
 * raw `git push` get a clear error rather than a silent
 * operator-attributed push.
 */

import { execa } from 'execa';

// Two empty-string entries: the first resets any inherited helper
// (per git's documented "empty string resets earlier helpers" rule);
// the second leaves no helper installed at the repo-local layer.
// `--replace-all` ensures we collapse any prior values into the
// canonical two-empty-entry shape.
async function setEmptyCredentialHelper() {
  // First clear all existing entries with a single empty value, then
  // append a second empty. The two-entry form is what git-config emits
  // when an operator runs --replace-all + --add, so we stay byte-shape
  // identical to the manual setup. Idempotent: a re-run lands on the
  // same final config.
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
  };
  const replace = await execa(
    'git',
    ['config', '--local', '--replace-all', 'credential.helper', ''],
    { env, reject: false },
  );
  if (replace.exitCode !== 0 && replace.exitCode !== 5) {
    // exitCode 5 means "no matching key found" on --replace-all when
    // the key does not yet exist; treat that as success because the
    // follow-up --add still establishes the entry. Anything else is
    // a real failure.
    process.stderr.write(
      `[setup-local-git-config] failed to clear credential.helper: ${replace.stderr ?? '(no stderr)'}\n`,
    );
    process.exit(1);
  }
  const add = await execa(
    'git',
    ['config', '--local', '--add', 'credential.helper', ''],
    { env, reject: false },
  );
  if (add.exitCode !== 0) {
    process.stderr.write(
      `[setup-local-git-config] failed to add empty credential.helper: ${add.stderr ?? '(no stderr)'}\n`,
    );
    process.exit(1);
  }
}

async function main() {
  // Confirm we are inside a git repo before touching config. A bare
  // `git config --local` outside a repo errors with "fatal: not in a
  // git repository", but emitting a friendlier line first avoids the
  // confusing stderr trail when a curious operator runs the script
  // from a scratch directory.
  const inside = await execa('git', ['rev-parse', '--is-inside-work-tree'], {
    reject: false,
  });
  if (inside.exitCode !== 0 || (inside.stdout ?? '').trim() !== 'true') {
    // Silent success on the non-repo path: `npm install` may run this
    // script in a tarball context (e.g. consumer of this package) and
    // surfacing a hard error there is wrong. The setup is for the
    // repo's own contributors; downstream consumers do not need it.
    return;
  }
  await setEmptyCredentialHelper();
  process.stdout.write(
    '[setup-local-git-config] credential.helper="" applied to .git/config '
      + '(every git op in this repo skips GCM; tokens still flow via git-as.mjs)\n',
  );
}

main().catch((err) => {
  process.stderr.write(
    `[setup-local-git-config] unexpected: ${err?.message ?? err}\n`,
  );
  process.exit(1);
});
