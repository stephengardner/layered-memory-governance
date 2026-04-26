import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  ShieldAlert,
  ShieldCheck,
  AlertOctagon,
  Users,
  FileCode,
  Clock,
  UserCog,
  History,
  KeyRound,
  Activity,
  AlertTriangle,
} from 'lucide-react';
import {
  getControlStatus,
  type ActiveElevationSummary,
  type AutonomyTier,
  type ControlStatus,
  type EscalationSummary,
  type KillSwitchTransitionSummary,
  type OperatorActionSummary,
} from '@/services/control.service';
import { ErrorState, LoadingState } from '@/components/state-display/StateDisplay';
import styles from './ControlPanelView.module.css';

/**
 * Operator Control Panel.
 *
 * Surfaces the load-bearing governance invariants in one place:
 *   1. Kill-switch state -- is the .lag/STOP sentinel engaged?
 *   2. Autonomy tier -- soft / medium / hard
 *   3. Recent kill-switch transitions
 *   4. Currently-elevated policy atoms with countdown to expiry
 *   5. Recent operator actions (top 10)
 *   6. Recent escalations
 *
 * plus four context tiles (actors governed, policies active, last
 * canon apply, operator principal id) so the operator has a single
 * pane that answers "what's the autonomy posture right now?".
 *
 * Color semantics:
 *   - default state (kill-switch off, tier=soft) renders as calm
 *     accent (NOT danger). Defaulting to red on the healthy default
 *     would fatigue the operator and erode signal-to-noise when a
 *     real halt lands.
 *   - kill-switch engaged: danger surface, large alert icon
 *   - tier=medium: warning surface
 *   - tier=hard: danger surface
 *
 * Read-only contract (v1):
 *   - The "Engage Kill Switch" button does NOT write the sentinel
 *     file. It opens a confirmation dialog explaining the manual
 *     `touch .lag/STOP` command. Engaging the kill switch crosses
 *     the operator-shell trust boundary and is intentionally out of
 *     scope for the console UI -- a UI-driven halt would let any
 *     CSRF or compromised browser session take down the org.
 *   - Releasing the kill switch is even more dangerous and is
 *     deliberately CLI-only (delete the file in person, on the
 *     operator's shell, with full env).
 *
 * Refresh cadence: TanStack Query refetches every 3 seconds so the
 * operator sees state changes promptly. SSE could replace polling
 * later, but for v1 a 3s poll is well under the human-noticeable
 * threshold and avoids new server seams.
 */
const REFETCH_MS = 3_000;

/*
 * Heroic visual tone. `engaged` (kill-switch on) wins over tier; if
 * the org is halted the operator should see danger no matter what
 * tier was set. Otherwise tier dictates: soft = neutral accent
 * (default healthy), medium = warning, hard = danger.
 */
type HeroTone = 'neutral' | 'warning' | 'danger';
function pickHeroTone(engaged: boolean, tier: AutonomyTier): HeroTone {
  if (engaged) return 'danger';
  if (tier === 'hard') return 'danger';
  if (tier === 'medium') return 'warning';
  return 'neutral';
}

export function ControlPanelView() {
  const [confirmOpen, setConfirmOpen] = useState(false);

  const statusQuery = useQuery({
    queryKey: ['control-status'],
    queryFn: ({ signal }) => getControlStatus(signal),
    refetchInterval: REFETCH_MS,
    refetchIntervalInBackground: false,
  });

  if (statusQuery.isPending) {
    return (
      <section className={styles.viewer} aria-busy="true">
        <LoadingState label="Reading governance state…" testId="control-loading" />
      </section>
    );
  }
  if (statusQuery.isError) {
    return (
      <section className={styles.viewer}>
        <ErrorState
          title="Could not load control status"
          message={(statusQuery.error as Error).message}
          testId="control-error"
        />
      </section>
    );
  }

  const status: ControlStatus = statusQuery.data;
  const engaged = status.kill_switch.engaged;
  const tone = pickHeroTone(engaged, status.autonomy_tier);

  return (
    <section className={styles.viewer} data-testid="control-panel" aria-busy={statusQuery.isFetching}>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Operator Control Panel</h1>
        <p className={styles.pageSubtitle}>
          Live governance posture. Auto-refreshes every {REFETCH_MS / 1000} seconds.
        </p>
      </header>

      <KillSwitchHero
        engaged={engaged}
        tone={tone}
        tier={status.autonomy_tier}
        sentinelPath={status.kill_switch.sentinel_path}
        engagedAt={status.kill_switch.engaged_at}
        onEngageClick={() => setConfirmOpen(true)}
      />

      <TierBanner tier={status.autonomy_tier} engaged={engaged} />

      <MetricsGrid status={status} />

      <ActiveElevationsSection elevations={status.active_elevations} />

      <KillSwitchHistorySection transitions={status.recent_kill_switch_transitions} />

      <OperatorActionsSection actions={status.recent_operator_actions} />

      <EscalationsSection escalations={status.recent_escalations} />

      <EngageDialog
        open={confirmOpen}
        sentinelPath={status.kill_switch.sentinel_path}
        engaged={engaged}
        onClose={() => setConfirmOpen(false)}
      />
    </section>
  );
}

function KillSwitchHero({
  engaged,
  tone,
  tier,
  sentinelPath,
  engagedAt,
  onEngageClick,
}: {
  readonly engaged: boolean;
  readonly tone: HeroTone;
  readonly tier: AutonomyTier;
  readonly sentinelPath: string;
  readonly engagedAt: string | null;
  readonly onEngageClick: () => void;
}) {
  /*
   * Plain-English caption answering "is anything wrong?" in one
   * sentence. The default (engaged=false, tier=soft) explicitly
   * narrates that the system is healthy; the operator should NOT
   * have to infer health from the absence of red.
   */
  const caption = engaged
    ? `Kill switch engaged${engagedAt ? ` at ${formatIso(engagedAt)}` : ''}. Actors will not start a new turn.`
    : tier === 'hard'
      ? 'Hard tier active. Runtime fully gated; no actor may make progress.'
      : tier === 'medium'
        ? 'Medium tier active. In-flight turns may be halted mid-step.'
        : 'Autonomous loop running normally. STOP sentinel absent; soft-tier governance gates active.';
  return (
    <motion.div
      className={styles.hero}
      data-engaged={engaged}
      data-tone={tone}
      data-tier={tier}
      data-testid="control-kill-switch"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
    >
      <div className={styles.heroIcon} aria-hidden="true">
        {engaged
          ? <AlertOctagon size={48} strokeWidth={1.5} />
          : <ShieldCheck size={48} strokeWidth={1.5} />}
      </div>
      <div className={styles.heroBody}>
        <p className={styles.heroEyebrow}>Kill Switch</p>
        <h2 className={styles.heroTitle} data-testid="control-kill-switch-title">
          {engaged ? 'Engaged' : 'Not engaged'}
        </h2>
        <p className={styles.heroDetail}>
          {engaged
            ? `The org is halted. Sentinel ${sentinelPath} appeared${engagedAt ? ` at ${formatIso(engagedAt)}` : ''}. Actors that observe the sentinel will not start a new turn.`
            : `No sentinel file at ${sentinelPath}. Actors run under the active autonomy tier.`}
        </p>
        <p className={styles.heroCaption} data-testid="control-kill-switch-caption">
          {caption}
        </p>
      </div>
      <button
        type="button"
        className={styles.heroEngage}
        data-testid="control-engage-button"
        onClick={onEngageClick}
        disabled={engaged}
      >
        <ShieldAlert size={16} strokeWidth={1.75} aria-hidden="true" />
        {engaged ? 'Sentinel present' : 'Engage Kill Switch'}
      </button>
    </motion.div>
  );
}

function TierBanner({ tier, engaged }: { readonly tier: AutonomyTier; readonly engaged: boolean }) {
  const meta = TIER_META[tier];
  return (
    <div className={styles.tierBanner} data-tier={tier} data-engaged={engaged} data-testid="control-tier-banner">
      <div className={styles.tierLabel}>
        <span className={styles.tierBadge} data-tier={tier} data-testid={`control-tier-${tier}`}>
          {tier.toUpperCase()}
        </span>
        <span className={styles.tierName}>{meta.name}</span>
      </div>
      <p className={styles.tierDetail}>{meta.detail}</p>
    </div>
  );
}

function MetricsGrid({ status }: { readonly status: ControlStatus }) {
  return (
    <div className={styles.metrics} data-testid="control-metrics">
      <MetricTile
        icon={Users}
        label="Actors governed"
        value={String(status.actors_governed)}
        testId="control-metric-actors"
      />
      <MetricTile
        icon={FileCode}
        label="Policies active"
        value={String(status.policies_active)}
        testId="control-metric-policies"
      />
      <MetricTile
        icon={Clock}
        label="Last canon apply"
        value={formatRelative(status.last_canon_apply) ?? 'Never'}
        testId="control-metric-canon"
      />
      <MetricTile
        icon={UserCog}
        label="Operator principal"
        value={status.operator_principal_id}
        testId="control-metric-operator"
        mono
      />
    </div>
  );
}

function MetricTile({
  icon: Icon,
  label,
  value,
  testId,
  mono,
}: {
  readonly icon: typeof Users;
  readonly label: string;
  readonly value: string;
  readonly testId: string;
  readonly mono?: boolean;
}) {
  return (
    <div className={styles.tile} data-testid={testId}>
      <div className={styles.tileIcon} aria-hidden="true">
        <Icon size={18} strokeWidth={1.75} />
      </div>
      <p className={styles.tileLabel}>{label}</p>
      <p className={mono ? styles.tileValueMono : styles.tileValue} data-testid={`${testId}-value`}>{value}</p>
    </div>
  );
}

/*
 * Active elevations. Surfaces atoms whose
 * `metadata.elevation.expires_at` is in the future. Each row shows
 * the policy target + principal + remaining time so the operator
 * sees at a glance "what is currently bypassed and for how long?".
 *
 * Empty state is intentional: when no elevations are active, we say
 * so explicitly rather than hiding the section.
 */
function ActiveElevationsSection({
  elevations,
}: { readonly elevations: ReadonlyArray<ActiveElevationSummary> }) {
  return (
    <section className={styles.section} data-testid="control-active-elevations">
      <header className={styles.sectionHeader}>
        <KeyRound size={18} strokeWidth={1.75} aria-hidden="true" />
        <h3 className={styles.sectionTitle}>Active elevations</h3>
        <span className={styles.sectionCount} data-testid="control-active-elevations-count">
          {elevations.length}
        </span>
      </header>
      {elevations.length === 0 ? (
        <p className={styles.sectionEmpty}>No active elevations. All standing policies in force.</p>
      ) : (
        <ul className={styles.list} role="list">
          {elevations.map((e) => (
            <li key={e.atom_id} className={styles.row} data-testid="control-elevation-row">
              <div className={styles.rowMain}>
                <span className={styles.rowKind}>{e.policy_target ?? 'policy'}</span>
                {e.principal ? (
                  <span className={styles.rowDetail}>
                    granted to <code className={styles.rowMono}>{e.principal}</code>
                  </span>
                ) : null}
              </div>
              <div className={styles.rowMeta}>
                <span className={styles.rowCountdown} title={`Expires ${e.expires_at}`}>
                  {formatCountdown(e.time_remaining_seconds)} remaining
                </span>
                <span className={styles.rowAtom}>
                  <code className={styles.rowMono}>{e.atom_id}</code>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function KillSwitchHistorySection({
  transitions,
}: { readonly transitions: ReadonlyArray<KillSwitchTransitionSummary> }) {
  return (
    <section className={styles.section} data-testid="control-kill-switch-history">
      <header className={styles.sectionHeader}>
        <History size={18} strokeWidth={1.75} aria-hidden="true" />
        <h3 className={styles.sectionTitle}>Recent kill-switch transitions</h3>
        <span className={styles.sectionCount}>{transitions.length}</span>
      </header>
      {transitions.length === 0 ? (
        <p className={styles.sectionEmpty}>No transitions recorded.</p>
      ) : (
        <ul className={styles.list} role="list">
          {transitions.map((t) => (
            /*
             * Key off atom_id when present (per-transition atom row);
             * fall back to a 'live-' prefix on (at, tier) for the
             * live-state snapshot row, which has no atom of record.
             * Avoids React key collisions once the per-transition
             * atom writer ships and emits a row at the same ms as
             * the state-file `since` field.
             */
            <li key={t.atom_id ?? `live-${t.at}-${t.tier}`} className={styles.row} data-testid="control-history-row">
              <div className={styles.rowMain}>
                <span className={styles.tierBadge} data-tier={t.tier === 'off' ? 'soft' : t.tier}>
                  {t.tier.toUpperCase()}
                </span>
                <span className={styles.rowDetail}>
                  {t.transitioned_by ? (
                    <>by <code className={styles.rowMono}>{t.transitioned_by}</code></>
                  ) : 'unknown actor'}
                  {t.reason ? <> -- {t.reason}</> : null}
                </span>
              </div>
              <span className={styles.rowMeta}>{formatRelative(t.at) ?? formatIso(t.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function OperatorActionsSection({
  actions,
}: { readonly actions: ReadonlyArray<OperatorActionSummary> }) {
  return (
    <section className={styles.section} data-testid="control-operator-actions">
      <header className={styles.sectionHeader}>
        <Activity size={18} strokeWidth={1.75} aria-hidden="true" />
        <h3 className={styles.sectionTitle}>Recent operator actions</h3>
        <span className={styles.sectionCount}>{actions.length}</span>
      </header>
      {actions.length === 0 ? (
        <p className={styles.sectionEmpty}>No recent operator actions.</p>
      ) : (
        <ul className={styles.list} role="list">
          {actions.map((a) => (
            <li key={a.atom_id} className={styles.row} data-testid="control-action-row">
              <div className={styles.rowMain}>
                <span className={styles.rowKind}>{a.kind}</span>
                <span className={styles.rowDetail}>
                  by <code className={styles.rowMono}>{a.principal_id}</code>
                </span>
              </div>
              <span className={styles.rowMeta}>{formatRelative(a.at) ?? formatIso(a.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EscalationsSection({
  escalations,
}: { readonly escalations: ReadonlyArray<EscalationSummary> }) {
  return (
    <section className={styles.section} data-testid="control-escalations">
      <header className={styles.sectionHeader}>
        <AlertTriangle size={18} strokeWidth={1.75} aria-hidden="true" />
        <h3 className={styles.sectionTitle}>Recent escalations</h3>
        <span className={styles.sectionCount} data-testid="control-escalations-count">
          {escalations.length}
        </span>
      </header>
      {escalations.length === 0 ? (
        <p className={styles.sectionEmpty}>No escalations. Sub-actor dispatch is healthy.</p>
      ) : (
        <ul className={styles.list} role="list">
          {escalations.map((e) => (
            <li key={e.atom_id} className={styles.row} data-testid="control-escalation-row">
              <div className={styles.rowMain}>
                <span className={styles.rowDetail}>{e.headline}</span>
              </div>
              <div className={styles.rowMeta}>
                <span>{formatRelative(e.at) ?? formatIso(e.at)}</span>
                <span className={styles.rowAtom}>
                  <code className={styles.rowMono}>{e.atom_id}</code>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EngageDialog({
  open,
  sentinelPath,
  engaged,
  onClose,
}: {
  readonly open: boolean;
  readonly sentinelPath: string;
  readonly engaged: boolean;
  readonly onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  /*
   * Operator-critical surface a11y contract:
   *   - Escape dismisses the dialog (universal modal expectation; a
   *     keyboard-only operator must be able to back out without
   *     hunting for the Close button).
   *   - Scrim click dismisses (the dialog is informational, not a
   *     destructive confirm; the read-only contract guarantees no
   *     write happens regardless).
   *   - Focus lands on the Close button when the dialog opens so
   *     keyboard users do not have to tab from the page behind it.
   *
   * NOT implemented here: a strict focus trap. The dialog has a single
   * focusable element (Close) plus the document body, so Tab cycling
   * is naturally bounded. If we later add fields or extra actions we
   * should swap to a shared Dialog primitive (Radix/shadcn) so we
   * inherit a real trap.
   */
  useEffect(() => {
    if (!open) return;
    closeButtonRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className={styles.dialogScrim}
      role="presentation"
      data-testid="control-engage-dialog-scrim"
      onClick={onClose}
    >
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="engage-dialog-title"
        data-testid="control-engage-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="engage-dialog-title" className={styles.dialogTitle}>
          Engage the kill switch from your shell
        </h3>
        <p className={styles.dialogBody}>
          The console is read-only by contract. Engaging the kill switch crosses the
          operator-shell trust boundary -- a UI-driven halt would let any CSRF or compromised
          browser session take down the org. Run the command below in a terminal you trust:
        </p>
        <pre className={styles.dialogCommand} data-testid="control-engage-command">
          <code>touch {sentinelPath}</code>
        </pre>
        <p className={styles.dialogBody}>
          {engaged
            ? `The sentinel is already present. Running touch is a no-op.`
            : `Once the file exists, every actor that polls the sentinel will halt before starting its next turn. To release the halt, delete the file from the same shell.`}
        </p>
        <div className={styles.dialogActions}>
          <button
            type="button"
            ref={closeButtonRef}
            className={styles.dialogClose}
            data-testid="control-engage-dialog-close"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

interface TierMeta {
  readonly name: string;
  readonly detail: string;
}

const TIER_META: Record<AutonomyTier, TierMeta> = {
  soft: {
    name: 'Soft',
    detail: 'Default tier. STOP sentinel halts new turns. Governance gates run on every write. Medium and hard tiers are reserved per `inv-kill-switch-design-first`.',
  },
  medium: {
    name: 'Medium',
    detail: 'Reserved tier. CLI-engaged. Halts in-flight turns mid-step. Roadmap, not yet active.',
  },
  hard: {
    name: 'Hard',
    detail: 'Reserved tier. CLI-engaged. Fully gated runtime; no actor may make progress until the operator releases.',
  },
};

function formatIso(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString();
}

function formatRelative(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const delta = Date.now() - t;
  if (delta < 0) return new Date(t).toLocaleString();
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/*
 * Countdown formatter for active-elevation rows. Renders the largest
 * unit that fits ("7h 12m", "45m", "12s") so the operator gets a
 * glance-friendly remaining-time without millisecond precision.
 */
function formatCountdown(seconds: number): string {
  if (seconds <= 0) return 'expired';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes - hours * 60;
  if (hours < 24) return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours - days * 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}
