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
- `lag-respond`: interactive human-approval prompt for pending notifications.
- `lag-compromise`: incident response; cascades taint when a principal is marked compromised.
- `lag-actors`: per-role GitHub App identity provisioning.
- `lag-tg`: Telegram-daemon lifecycle (`start | stop | status | restart`).

## Bootstrap from an existing memory store

```bash
node scripts/ingest.mjs --source claudecode:./transcripts.jsonl
node scripts/bootstrap.mjs
```

## What to read next

- [`docs/architecture.md`](architecture.md) for the governance model.
- [`docs/integration.md`](integration.md) for plug-in points and the `cr-precheck` capability.
- [`docs/loops/agentic-actor-loop.md`](loops/agentic-actor-loop.md) for the substrate plus executor plus adapter trilogy.
