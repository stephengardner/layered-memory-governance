# Bot identities for LAG actors

Every LAG actor that touches GitHub can do so under its own bot identity instead of the operator's personal scope. Comments, PR opens, merges, and review replies are attributed to `<role>[bot]`, not the human.

## One-time setup

Declare the actor in `roles.json`, then provision via the CLI:

```powershell
node bin/lag-actors.js sync
```

This opens your browser for each un-provisioned role, you click "Create GitHub App", then "Install" on the target repo. Credentials land in `.lag/apps/<role>.json` + `.lag/apps/keys/<role>.pem` (both gitignored). The App is attributed to `<role>[bot]` in GitHub UI.

Currently provisioned roles (see `roles.json`):

- `lag-pr-landing`  -  PR-landing actor; replies to review threads, resolves nits.
- `lag-cto`  -  CTO actor's GitHub-facing hand; opens PRs for code-change plans, authors CodeRabbit replies as CTO. Cannot merge (`pol-cto-no-merge`).

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
| PR open for a plan the CTO produced | `lag-cto` | The CTO authored the plan; the PR should reflect authorship. |
| Review-thread reply on a PR the CTO opened | `lag-cto` | Continuity: the author of the PR replies to reviewer findings. |
| Resolve nits, re-request review after fix | `lag-pr-landing` | That's the pr-landing actor's job; delegated authority. |
| `git commit` locally | operator or `lag-cto` | Commits can be authored by a bot via `git config user.email` per repo; PR-open via `gh-as.mjs lag-cto` then attributes the PR to the bot regardless. |
| PR merge | **operator only** | Canon `pol-cto-no-merge` keeps merge authority out of bot scope until the medium-tier kill switch ships. |
| Opening issues to track operational findings | actor whose finding it is | e.g. `lag-auditor` would open the issue if a GitHub output channel were wired. |

## Audit trail

Every App action is attributed to `<role>[bot]` in GitHub's UI AND to the operator who provisioned the App (App settings page, "Created by"). The operator retains revocation authority: visit the App settings, click Uninstall, the App loses write access immediately.

## Rotation

The private key in `.lag/apps/keys/<role>.pem` is operator-sensitive. To rotate:

1. GitHub App settings → "Generate a new private key"
2. Replace `.lag/apps/keys/<role>.pem` with the downloaded PEM
3. Revoke the old key in the same settings page

The App id and installation id are stable across key rotations; only the PEM changes.

## Files involved

- `roles.json`  -  declarative role spec (name, permissions, description ≤ 240 chars)
- `bin/lag-actors.js`  -  CLI (`sync`, `list`, `demo-pr`, `demo-adapter`)
- `scripts/gh-token-for.mjs`  -  token mint helper
- `scripts/gh-as.mjs`  -  `gh` wrapper with auto-minted token
- `.lag/apps/<role>.json`  -  provisioned credentials (gitignored)
- `.lag/apps/keys/<role>.pem`  -  private key (gitignored)
