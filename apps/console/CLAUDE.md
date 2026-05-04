# LAG Console — agent operating notes

Any agent (Claude Code session, subagent, CI job) working inside `apps/console/` inherits the rules below. These are hard constraints; violating them is a review-fail, not a nit.

## The 11 principles (canon-atomized under `dev-web-*`)

1. **Stack**: React + shadcn. TypeScript strict.
2. **No Tailwind utility classes in our own component source.** shadcn source (vendored) uses Tailwind internally — that's fine, we own it. Our hand-written components use semantic classes that resolve to tokens.
3. **No hardcoded px or hex outside `src/tokens/tokens.css`.** stylelint enforces on commit.
4. **No `useEffect` for data.** Data fetching through TanStack Query hooks that call services. `useEffect` survives only for real DOM side effects (focus management, observers). Business logic lives in `src/services/`.
5. **Modern wow-factor UI.** Linear/Vercel/Arc aesthetic tier. Motion considered (framer-motion). Dark-mode first-class. Every empty/loading/error state polished.
6. **Playwright e2e required** for every feature (≥1 test in `tests/e2e/<feature>.spec.ts`).
7. **Untested UI behavior does not ship.** CI gate rejects PRs.
8. **Folder structure is feature-grouped**, not type-grouped. `src/features/<feature>/` owns components + services + tests. `src/components/` holds cross-feature primitives only.
9. **Transport abstraction.** All data access flows through `src/services/transport/`. Direct `fetch()` is banned outside the transport implementations. Runtime detection (web vs Tauri) lives in ONE file. This is what makes the future Tauri port a 1-day swap instead of a rewrite.
10. **No direct platform storage.** No `localStorage`/`sessionStorage`/`document.cookie` in components or features. Storage via `src/services/storage.service.ts` so the Tauri swap is painless.
11. **Multi-theme-ready tokens via `@layer` + body class.** Tokens live inside `@layer tokens` (modern cascade control, deterministic regardless of import order). Themes select via body class (`<body class="theme-dark">`, `theme-light`, `theme-<any-future-name>`) — NOT `data-theme` attribute. Adding a new theme is a single CSS block that redefines the palette layer; components never branch on theme because they consume semantic tokens (surface-*/text-*/accent-*). To prevent flash-of-wrong-theme on first paint, `index.html` has an inline script that reads the persisted preference + applies the body class BEFORE React mounts.

## Before starting any work in this subtree

- Know what processes are already running (dashboard port 9080, backend port 9081), never start a second instance from a different worktree. `npm run dev` runs a `predev` cleanup hook (`scripts/dev-server-cleanup.mjs`) that kills stale tsx-watch and vite children from prior loop runs, but if you are unsure inspect the OS process table directly (`tasklist` on Windows, `ps -ef | grep tsx` on POSIX). The PID records live at `apps/console/.lag-dev-servers/`.
- Read the token system at `src/tokens/tokens.css` before styling anything.
- Read the transport abstraction at `src/services/transport/` before fetching anything.

## Test discipline

- Unit tests: Vitest (`npm test`). Co-located with the feature.
- E2E tests: Playwright (`npm run e2e`). Headed during development (`npm run e2e:headed`).
- Every feature PR adds an e2e. Features without tests fail CI.

## Ports (reserved, not guessed)

| Port | Process |
|---|---|
| 9080 | Vite dev server (the dashboard) |
| 9081 | Backend API server (reads `.lag/`) |

Vite proxies `/api/*` to 9081 so the frontend sees one origin.

## Scope boundaries

- This app is **read-only** in v1. Writes go through existing LAG CLIs (`decide`, `gh-as`, etc.). No mutation endpoints in the backend.
- Stays on `feat/console-foundation` branch in the `../memory-governance-apps` worktree. The main `memory-governance/` checkout is for other work.
- Does NOT touch `src/actors/`, `src/adapters/`, canon schemas, or any file outside `apps/console/` except in explicit integration PRs (which will be rare).

### Read-only invariant: how it is enforced today

Two narrow exceptions to the no-write rule live in `server/index.ts` and are gated explicitly so the default install stays read-only:

| Route | Default | Gating |
|---|---|---|
| `/api/kill-switch.transition` | enabled | UI may transition to `off` or `soft` only; medium/hard remain CLI-gated (canon `dec-kill-switch-design-first`). Origin-allowlist enforced. |
| `/api/atoms.propose` | **disabled** | Returns 403 `console-read-only` unless `LAG_CONSOLE_ALLOW_WRITES=1` is set. When enabled, writes at `layer: L0` with `validation_status: pending_review` (intake, not auto-canonization). Origin-allowlist enforced. |

The `LAG_CONSOLE_ALLOW_WRITES` env var is the dev-only escape hatch for the propose flow. An out-of-the-box install does not mint atoms from the UI; developers who want the proposer flow flip the flag deliberately. Production deployments leave it unset.

Other write-shaped routes (`/api/atoms.reinforce`, `/api/atoms.mark-stale`) are not yet gated by this flag and remain operator-tracked debt; see PR follow-up for `dev-substrate-not-prescription` alignment.

## Future port to Tauri

Not now. The transport abstraction (principle #9) is the ONE piece that keeps this cheap later. If Tauri happens, it's a 1-2 day swap: add Rust backend + `TauriTransport` impl; zero component code changes.
