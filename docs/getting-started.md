> Last validated end-to-end through the autonomous loop on 2026-04-26.

# Getting started

Node 22+. TypeScript optional. A few minutes from clone to a running governance loop.

## Install and bootstrap

```bash
npm install
npm run build
node examples/quickstart.mjs
```

That script spins up a memory-backed Host, seeds three atoms from three principals, searches them, runs a promotion pass to elevate the consensus into the L2 curated layer, and prints the resulting state plus the audit log.

## Daemons and surfaces

Three daemon modes plus a terminal session share the same `.lag/` substrate:

- **Terminal** for head-down development; just run your usual editor session.
- **Wrapper** (`npm run terminal` / `terminal:auto`): launches an interactive agent session inside a node-pty with an embedded Telegram long-poller; replies inject directly into stdin.
- **Stateless daemon** (`node scripts/daemon.mjs`): each Telegram message spawns a fresh `claude -p`; ideal for autonomous-org setups.
- **Resume-shared daemon** (`--resume-session <id>` or `--resume-latest`): replies append to the shared jsonl so a terminal session sees them on its next turn.
- **Queue + hook** (`--queue-only`): pair with `examples/hooks/lag-tg-attached-stop.cjs` to have the live terminal session answer Telegram via a Stop hook.

## Operator commands

- `lag-run-loop`: autonomous tick daemon (decay, TTL, promotion, canon render).
  - `--reap-stale-plans`: enable the reaper-pass on every tick. Two sub-passes run (decoupled; one fault does not cascade):
    - **Plan reaper**: abandon plans stuck in `proposed` past the TTL (default 24h warn / 72h abandon). Override via `pol-reaper-ttls` canon (preferred; seed with `node scripts/bootstrap-reaper-canon.mjs`) or `--reaper-warn-ms` / `--reaper-abandon-ms`.
    - **Pipeline reaper**: stamp `metadata.reaped_at` on stale terminal pipelines (default 30d), HIL-paused pipelines (14d), and standalone agent sessions (30d). Atoms are NEVER deleted; the label IS the change, with confidence floored at 0.01 so arbitration deprioritizes them. Override via `pol-pipeline-reaper-ttls` canon (preferred; seed with `node scripts/bootstrap-pipeline-reaper-canon.mjs`) or `LAG_PIPELINE_REAPER_TERMINAL_MS` / `_HIL_PAUSED_MS` / `_AGENT_SESSION_MS` env vars.
    - Both sub-passes share `--reaper-principal` (or `LAG_REAPER_PRINCIPAL` env, or fall through to the loop's own principal). Provision the default `lag-loop` attribution principal once via `node scripts/bootstrap-lag-loop-principal.mjs`.
    - For an out-of-band sweep without running the full loop, use `node scripts/reap-stale-pipelines.mjs --dry-run` (preview) then live without the flag. The Console's `/activities` view hides reaped atoms by default; toggle "Show reaped (N)" to surface them. Provenance navigation (`derived_from`) still resolves reaped atoms even when the projection-layer filter hides them.
  - `--reconcile-pr-orphans`: detect open PRs with no active driver-claim (or with a stale claim) and dispatch a fresh driver sub-agent to drive the PR through CR + CI to merged state. Without this, an autonomous code-author PR that opens AND whose dispatching sub-agent terminates mid-CR-cycle sits idle until an operator notices. The reconciler walks `gh pr list` every 5min (canon-tunable via `pol-pr-orphan-reconcile-cadence-ms`), joins each PR with its `pr-driver-claim` atom, and shells out to `scripts/run-pr-fix.mjs` for orphans. Requires `GH_REPO=owner/repo` env (or a working `gh repo view`) so the reconciler knows which repo to scan. Per-tick dispatch is bounded (default 5; raise via `pol-pr-orphan-reconcile-max-dispatch-per-tick`). Override the activity-window threshold via `--pr-orphan-threshold-ms` or canon `pol-pr-orphan-reconcile-threshold-ms`.
- `lag-respond`: interactive human-approval prompt for pending notifications.
- `lag-compromise`: incident response; cascades taint when a principal is marked compromised.
- `lag-actors`: per-role GitHub App identity provisioning.
- `lag-tg`: Telegram-daemon lifecycle (`start | stop | status | restart`).

## Bootstrap from an existing memory store

```bash
node scripts/ingest.mjs --source claudecode:./transcripts.jsonl
node scripts/bootstrap.mjs
```

## Pulse heartbeat for terminal sessions (optional)

The Live Ops Pulse dashboard counts agent activity from `agent-session` and `agent-turn` atoms. LAG actor flows (PrFix, code-author, resume-author) mint these automatically. To make the dashboard reflect operator-led terminal work too, the SessionStart and PostToolUse hooks in `.claude/hooks/` mint operator session/turn atoms, but ONLY when `LAG_OPERATOR_ID` is exported in the shell that launches Claude Code:

```bash
export LAG_OPERATOR_ID=<your-operator-principal-id>   # must exist in .lag/principals/
```

Without it, the hooks skip silently (by design: no silent-default fallback per inv-governance-before-autonomy) and the Pulse heartbeat stays at zero during hands-on work. Set it once in your shell profile and the dashboard warms up on next session.

## What to read next

- [`docs/architecture.md`](architecture.md) for the governance model.
- [`docs/integration.md`](integration.md) for plug-in points and the `cr-precheck` capability.
- [`docs/loops/agentic-actor-loop.md`](loops/agentic-actor-loop.md) for the substrate plus executor plus adapter trilogy.
