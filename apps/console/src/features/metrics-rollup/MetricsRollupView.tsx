import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { CheckCircle2, AlertCircle, Coins, Timer, MessagesSquare } from 'lucide-react';
import {
  LoadingState,
  ErrorState,
} from '@/components/state-display/StateDisplay';
import {
  getMetricsRollup,
  type MetricsRollup,
  type MetricsRollupFailure,
} from '@/services/metrics.service';
import { setRoute } from '@/state/router.store';
import styles from './MetricsRollupView.module.css';

/**
 * MetricsRollupView - the conference-demo dashboard.
 *
 * Hero: succeeded vs failed runs in the window, big numbers, calm
 * typography. Below: median drafter cost, dispatch-to-merge latency,
 * and CR rounds per PR - the three numbers that tell the operator
 * whether the autonomous loop is healthy. At the bottom: most-recent
 * failures with click-through to the plan-lifecycle timeline so an
 * operator can drop into "what just broke" in one click.
 *
 * Read-only. The endpoint computes, returns, and never writes.
 */

const WINDOW_OPTIONS: ReadonlyArray<{ label: string; hours: number }> = [
  { label: '24h', hours: 24 },
  { label: '7d', hours: 24 * 7 },
  { label: '30d', hours: 24 * 30 },
];

export function MetricsRollupView() {
  const [windowHours, setWindowHours] = useState<number>(24);
  const query = useQuery({
    queryKey: ['metrics-rollup', windowHours],
    queryFn: ({ signal }) => getMetricsRollup(windowHours, signal),
  });

  return (
    <section className={styles.view} data-testid="metrics-rollup-view">
      <header className={styles.intro}>
        <div className={styles.titleBlock}>
          <h2 className={styles.heroTitle}>Autonomous-loop health</h2>
          <p className={styles.heroSubtitle}>
            Live digest of the last {labelForWindow(windowHours)} of LAG governance activity:
            atom volume, plan outcomes, drafter economics, and recent failures.
          </p>
        </div>
        <WindowPicker value={windowHours} onChange={setWindowHours} />
      </header>

      {query.isPending && <LoadingState label="Loading metrics..." testId="metrics-rollup-loading" />}
      {query.isError && (
        <ErrorState
          title="Could not load metrics"
          message={(query.error as Error).message}
          testId="metrics-rollup-error"
        />
      )}
      {query.isSuccess && <RollupBody data={query.data} />}
    </section>
  );
}

function WindowPicker({
  value,
  onChange,
}: {
  value: number;
  onChange: (hours: number) => void;
}) {
  return (
    <div className={styles.windowPicker} role="group" aria-label="Time window">
      {WINDOW_OPTIONS.map((opt) => {
        const active = opt.hours === value;
        return (
          <button
            key={opt.label}
            type="button"
            className={`${styles.windowBtn} ${active ? styles.windowBtnActive : ''}`}
            onClick={() => onChange(opt.hours)}
            aria-pressed={active}
            data-testid={`metrics-window-${opt.label}`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function RollupBody({ data }: { data: MetricsRollup }) {
  const { autonomous_loop, plans, recent_failures, atoms_total, atoms_in_window } = data;
  return (
    <>
      <div className={styles.heroGrid}>
        <HeroNumber
          tone="success"
          value={autonomous_loop.succeeded_in_window}
          label={autonomous_loop.succeeded_in_window === 1 ? 'successful run' : 'successful runs'}
          icon={CheckCircle2}
          testId="metrics-hero-succeeded"
          delay={0}
        />
        <HeroNumber
          tone="danger"
          value={autonomous_loop.failed_in_window}
          label={autonomous_loop.failed_in_window === 1 ? 'failure' : 'failures'}
          icon={AlertCircle}
          testId="metrics-hero-failed"
          delay={0.05}
        />
        <HeroNumber
          tone="neutral"
          value={autonomous_loop.dispatched_in_window}
          label={autonomous_loop.dispatched_in_window === 1 ? 'dispatch' : 'dispatches'}
          icon={undefined}
          testId="metrics-hero-dispatched"
          delay={0.1}
        />
      </div>

      <div className={styles.metricGrid}>
        <MetricCell
          icon={Coins}
          label="Median drafter cost"
          value={
            autonomous_loop.median_drafter_cost_usd === null
              ? null
              : `$${autonomous_loop.median_drafter_cost_usd.toFixed(2)}`
          }
          testId="metrics-median-cost"
        />
        <MetricCell
          icon={Timer}
          label="Median dispatch to merge"
          value={
            autonomous_loop.median_dispatch_to_merge_minutes === null
              ? null
              : formatMinutes(autonomous_loop.median_dispatch_to_merge_minutes)
          }
          testId="metrics-median-time"
        />
        <MetricCell
          icon={MessagesSquare}
          label="Median CodeRabbit rounds per PR"
          value={
            autonomous_loop.median_cr_rounds_per_pr === null
              ? null
              : autonomous_loop.median_cr_rounds_per_pr.toFixed(1)
          }
          testId="metrics-median-rounds"
        />
      </div>

      <PlansSummary
        total={plans.total}
        byState={plans.by_state}
        successRate={plans.success_rate}
        atomsTotal={atoms_total}
        atomsInWindow={atoms_in_window}
      />

      <RecentFailures failures={recent_failures} />
    </>
  );
}

function HeroNumber({
  tone,
  value,
  label,
  icon: Icon,
  testId,
  delay,
}: {
  tone: 'success' | 'danger' | 'neutral';
  value: number;
  label: string;
  icon: typeof CheckCircle2 | undefined;
  testId: string;
  delay: number;
}) {
  return (
    <motion.div
      className={`${styles.heroCard} ${styles[`heroCard_${tone}`]}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, delay, ease: [0.2, 0, 0, 1] }}
      data-testid={testId}
    >
      {Icon && (
        <span className={styles.heroIcon} aria-hidden="true">
          <Icon size={18} strokeWidth={2} />
        </span>
      )}
      <span className={styles.heroValue} data-testid={`${testId}-value`}>
        {value}
      </span>
      <span className={styles.heroLabel}>{label}</span>
    </motion.div>
  );
}

function MetricCell({
  icon: Icon,
  label,
  value,
  testId,
}: {
  icon: typeof Coins;
  label: string;
  value: string | null;
  testId: string;
}) {
  return (
    <motion.div
      className={styles.metricCell}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24 }}
      data-testid={testId}
    >
      <span className={styles.metricIcon} aria-hidden="true">
        <Icon size={14} strokeWidth={2} />
      </span>
      <span className={styles.metricLabel}>{label}</span>
      <span className={styles.metricValue} data-testid={`${testId}-value`}>
        {value ?? <span className={styles.metricEmpty}>n/a</span>}
      </span>
    </motion.div>
  );
}

function PlansSummary({
  total,
  byState,
  successRate,
  atomsTotal,
  atomsInWindow,
}: {
  total: number;
  byState: Readonly<Record<string, number>>;
  successRate: number;
  atomsTotal: number;
  atomsInWindow: number;
}) {
  const ordered: ReadonlyArray<{ key: string; label: string; tone: string }> = [
    { key: 'proposed', label: 'Proposed', tone: 'var(--accent)' },
    { key: 'approved', label: 'Approved', tone: 'var(--status-success)' },
    { key: 'executing', label: 'Executing', tone: 'var(--accent)' },
    { key: 'succeeded', label: 'Succeeded', tone: 'var(--status-success)' },
    { key: 'failed', label: 'Failed', tone: 'var(--status-danger)' },
    { key: 'abandoned', label: 'Abandoned', tone: 'var(--text-muted)' },
  ];

  return (
    <section className={styles.summaryCard} aria-labelledby="metrics-plans-heading">
      <header className={styles.summaryHead}>
        <h3 id="metrics-plans-heading" className={styles.summaryTitle}>
          Plans &amp; atoms
        </h3>
        <span className={styles.summarySub}>
          {atomsInWindow} of {atomsTotal} atoms in window
        </span>
      </header>
      <div className={styles.summaryRow}>
        <div className={styles.summaryStat} data-testid="metrics-plans-total">
          <span className={styles.summaryStatValue}>{total}</span>
          <span className={styles.summaryStatLabel}>plans total</span>
        </div>
        <div className={styles.summaryStat} data-testid="metrics-plans-success-rate">
          <span className={styles.summaryStatValue}>
            {Number.isFinite(successRate) ? `${Math.round(successRate * 100)}%` : 'n/a'}
          </span>
          <span className={styles.summaryStatLabel}>success rate</span>
        </div>
        <ul className={styles.stateList}>
          {ordered.map((s) => {
            const count = byState[s.key] ?? 0;
            if (count === 0) return null;
            return (
              <li key={s.key} className={styles.stateItem} data-state={s.key}>
                <span
                  className={styles.stateDot}
                  style={{ background: s.tone }}
                  aria-hidden="true"
                />
                <span className={styles.stateLabel}>{s.label}</span>
                <span className={styles.stateCount}>{count}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

function RecentFailures({ failures }: { failures: ReadonlyArray<MetricsRollupFailure> }) {
  if (failures.length === 0) {
    return (
      <section className={styles.failuresCard} aria-labelledby="metrics-failures-heading">
        <header className={styles.summaryHead}>
          <h3 id="metrics-failures-heading" className={styles.summaryTitle}>
            Recent failures
          </h3>
        </header>
        <p className={styles.failuresEmpty} data-testid="metrics-failures-empty">
          No failed dispatches in the recorded history. The loop is clean.
        </p>
      </section>
    );
  }

  return (
    <section className={styles.failuresCard} aria-labelledby="metrics-failures-heading">
      <header className={styles.summaryHead}>
        <h3 id="metrics-failures-heading" className={styles.summaryTitle}>
          Recent failures
        </h3>
        <span className={styles.summarySub}>{failures.length} most recent</span>
      </header>
      <ol className={styles.failuresList} data-testid="metrics-failures-list">
        {failures.map((f, i) => (
          <FailureRow key={`${f.plan_id}-${f.at}`} failure={f} index={i} />
        ))}
      </ol>
    </section>
  );
}

function FailureRow({ failure, index }: { failure: MetricsRollupFailure; index: number }) {
  const href = `/plan-lifecycle/${encodeURIComponent(failure.plan_id)}`;
  return (
    <motion.li
      className={styles.failureRow}
      initial={{ opacity: 0, x: -4 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.2, delay: Math.min(index * 0.04, 0.2) }}
      data-testid="metrics-failure-row"
      data-plan-id={failure.plan_id}
    >
      <a
        className={styles.failureLink}
        href={href}
        onClick={(e) => {
          if (e.defaultPrevented || e.button !== 0) return;
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          setRoute('plan-lifecycle', failure.plan_id);
        }}
      >
        <span className={styles.failureStage} data-testid="metrics-failure-stage">
          {failure.stage}
        </span>
        <span className={styles.failurePreview}>{failure.message_preview}</span>
        <time className={styles.failureTime} dateTime={failure.at}>
          {new Date(failure.at).toLocaleString()}
        </time>
      </a>
    </motion.li>
  );
}

function labelForWindow(hours: number): string {
  if (hours < 24) return `${hours}h`;
  if (hours === 24) return '24 hours';
  const days = Math.round(hours / 24);
  return `${days} days`;
}

function formatMinutes(minutes: number): string {
  if (minutes < 1) return `${Math.round(minutes * 60)}s`;
  if (minutes < 60) return `${minutes.toFixed(1)} minutes`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(1)} hours`;
  return `${(hours / 24).toFixed(1)} days`;
}
