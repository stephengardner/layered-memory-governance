# Bot identities for LAG actors

Every LAG actor that touches GitHub can do so under its own bot identity instead of the operator's personal scope. Comments, PR opens, and review replies are attributed to `<role>[bot]`, not the human. Merges flow through a specific bot only where policy permits (see the table below).

## One-time setup

Declare the actor in `roles.json`, then provision via the CLI:

```powershell
node bin/lag-actors.js sync
```

This opens your browser for each un-provisioned role, you click "Create GitHub App", then "Install" on the target repo. Credentials land in `.lag/apps/<role>.json` + `.lag/apps/keys/<role>.pem` (both gitignored). The App is attributed to `<role>[bot]` in GitHub UI.

Currently provisioned roles (see `roles.json`):

- `lag-pr-landing`  -  PR-landing actor; replies to review threads, resolves nits.
- `lag-cto`  -  CTO actor's GitHub-facing hand; opens PRs for code-change plans, authors CodeRabbit replies as CTO. Cannot merge (`pol-cto-no-merge`).
- `lag-ceo`  -  Operator's human-proxy identity. Opens PRs on the operator's behalf, posts operator-initiated PR comments and review replies, merges PRs when the operator delegates. NOT a decision-bearing authority; this bot's job is attribution only, so artifacts the operator ships through an agent do not carry the operator's personal login.

## Using a bot identity from a script or terminal

### Quick wrap via `scripts/gh-as.mjs`

Runs a standard `gh` CLI command under the bot identity. Fresh installation token minted per invocation, valid ~1 hour, not written to disk.

```powershell
node scripts/gh-as.mjs lag-cto pr create --title "feat: foo" --body "..."
node scripts/gh-as.mjs lag-pr-landing api repos/owner/repo/pulls/123/comments
```

The wrapper sets `GH_TOKEN` in the child process only. Parent shell `gh auth` state is untouched.

### Lower-level: just mint a token

If you need the raw token (for a non-`gh` consumer, a curl call, piping into another tool):

```powershell
$Env:GH_TOKEN = node scripts/gh-token-for.mjs lag-cto
gh pr create ...
# Remember to clear when done:
Remove-Item Env:GH_TOKEN
```

Or inline:

```bash
GH_TOKEN=$(node scripts/gh-token-for.mjs lag-cto) gh pr create ...
```

## Which identity to use when

| Operation | Identity | Why |
|---|---|---|
| PR open initiated by the operator (via an agent in session) | `lag-ceo` | Operator's human-proxy. Keeps the operator's personal login off the PR header without claiming decision authority. |
| PR open for a plan the CTO produced | `lag-cto` | The CTO authored the plan; the PR should reflect decision authorship, not operator-proxy attribution. |
| Review-thread reply on a PR the CTO opened | `lag-cto` | Continuity: the author of the PR replies to reviewer findings. |
| Review-thread reply on an operator-initiated PR | `lag-ceo` | Same attribution logic as the PR-open. |
| Resolve nits, re-request review after fix | `lag-pr-landing` | That's the pr-landing actor's job; delegated authority. |
| `git commit` locally | `lag-ceo` for operator-initiated work; `lag-cto` for CTO-authored plans | Commit author flows via `git config user.email` pointed at the bot's `<APP-ID>+<role>[bot]@users.noreply.github.com`. Keeps the operator's real name off every tracked commit. |
| PR merge initiated by the operator | `lag-ceo` | Operator is delegating the click; the bot runs the merge under operator authority. |
| PR merge initiated autonomously by the CTO | blocked until medium-tier kill switch ships | Canon `pol-cto-no-merge` and `dev-merge-authority-requires-medium-tier-kill-switch` keep autonomous merge out of bot scope. |
| Opening issues to track operational findings | actor whose finding it is | e.g. `lag-auditor` would open the issue if a GitHub output channel were wired. |

## How enforcement works (three layers)

Without mechanism, using the bot identities consistently is discipline; with mechanism, it is a repo invariant. Three layers stack to give a deterministic guarantee in this repo:

**Layer 1 - Credential isolation (automatic).**  `.lag/apps/<role>.json` and `.lag/apps/keys/<role>.pem` live in this repo's working tree. `scripts/gh-as.mjs <role>` reads them by relative path. In a different repo those files do not exist; `gh-as.mjs` errors out and `gh` falls back to the operator's global `gh auth`. Cross-repo credential leak is physically impossible.

**Layer 2 - Repo-local git identity (one-time config).**  Commit authorship is set per-repo via `git config --local user.email "<APP-ID>+<role>[bot]@users.noreply.github.com"` and `git config --local user.name "<role>[bot]"`. Every `git commit` in this clone carries the bot author. In another clone or another repo, a different (or the default operator) identity applies.

**Layer 3 - PreToolUse hook (checked-in enforcement).**  `.claude/hooks/enforce-lag-ceo-for-gh.mjs`, wired via `.claude/settings.json`, intercepts every Bash tool call in a Claude Code session, blocks raw `gh` invocations, and points the agent at `scripts/gh-as.mjs lag-ceo <args>`. The hook file is repo-scoped; in any other project it does not exist and the rule does not apply. Escape hatch: append `# allow-raw-gh` to a command for narrow legitimate cases.

The combined invariant: in this repo, any GitHub action an agent produces is attributed to a provisioned bot, OR the action fails loudly. There is no silent path to the operator's personal login.

## Audit trail

Every App action is attributed to `<role>[bot]` in GitHub's UI AND to the operator who provisioned the App (App settings page, "Created by"). The operator retains revocation authority: visit the App settings, click Uninstall, the App loses write access immediately.

## Rotation

The private key in `.lag/apps/keys/<role>.pem` is operator-sensitive. To rotate:

1. GitHub App settings → "Generate a new private key"
2. Replace `.lag/apps/keys/<role>.pem` with the downloaded PEM
3. Revoke the old key in the same settings page

The App id and installation id are stable across key rotations; only the PEM changes.

## Files involved

- `roles.json`  -  declarative role spec (name, permissions, description ≤ 1024 chars)
- `bin/lag-actors.js`  -  CLI (`sync`, `list`, `demo-pr`, `demo-adapter`)
- `scripts/gh-token-for.mjs`  -  token mint helper
- `scripts/gh-as.mjs`  -  `gh` wrapper with auto-minted token
- `.lag/apps/<role>.json`  -  provisioned credentials (gitignored)
- `.lag/apps/keys/<role>.pem`  -  private key (gitignored)
