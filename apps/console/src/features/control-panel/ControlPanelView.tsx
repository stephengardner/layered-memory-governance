import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { ShieldAlert, ShieldCheck, AlertOctagon, Users, FileCode, Clock, UserCog } from 'lucide-react';
import { getControlStatus, type AutonomyTier, type ControlStatus } from '@/services/control.service';
import { ErrorState, LoadingState } from '@/components/state-display/StateDisplay';
import styles from './ControlPanelView.module.css';

/**
 * Operator Control Panel.
 *
 * Surfaces the two load-bearing governance invariants in one place:
 *   1. Kill-switch state -- is the .lag/STOP sentinel engaged?
 *   2. Autonomy tier -- soft / medium / hard
 * plus four context tiles (actors governed, policies active, last
 * canon apply, operator principal id) so the operator has a single
 * pane that answers "what's the autonomy posture right now?".
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
        sentinelPath={status.kill_switch.sentinel_path}
        engagedAt={status.kill_switch.engaged_at}
        onEngageClick={() => setConfirmOpen(true)}
      />

      <TierBanner tier={status.autonomy_tier} engaged={engaged} />

      <MetricsGrid status={status} />

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
  sentinelPath,
  engagedAt,
  onEngageClick,
}: {
  readonly engaged: boolean;
  readonly sentinelPath: string;
  readonly engagedAt: string | null;
  readonly onEngageClick: () => void;
}) {
  return (
    <motion.div
      className={styles.hero}
      data-engaged={engaged}
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
