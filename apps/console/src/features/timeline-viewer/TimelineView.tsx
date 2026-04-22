import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { listCanonAtoms, type CanonAtom } from '@/services/canon.service';
import { listActivities } from '@/services/activities.service';
import { listPrincipals, type Principal } from '@/services/principals.service';
import { LoadingState, ErrorState } from '@/components/state-display/StateDisplay';
import { TimeAgo } from '@/components/time-ago/TimeAgo';
import { AtomHoverCard } from '@/components/hover-card/AtomHoverCard';
import { useHoverCard } from '@/components/hover-card/useHoverCard';
import { routeForAtomId, setRoute } from '@/state/router.store';
import styles from './TimelineView.module.css';

/**
 * Principal-chain timeline. The governance-native view the audit
 * agent called out: x-axis is time, y-axis is principal hierarchy
 * (roots at top, signed-by-descendants below), and atoms render as
 * dots placed at (principal, created_at). Edges would be
 * derived_from relationships — deferred to a later pass since they
 * cross rows and add layout complexity.
 *
 * What this view makes visible that the grid and graph don't:
 *   - WHO authored what, WHEN
 *   - How activity distributes across the principal hierarchy
 *     (is one actor writing everything? is the root idle?)
 *   - Temporal clustering of decisions — when did a workstream
 *     actually happen?
 *
 * Deliberate choices:
 *   - Time axis defaults to the last 14 days, the same window as
 *     the activity heatmap. Keeps the dashboard's time primitives
 *     consistent.
 *   - Principal rows are sorted by hierarchy depth then id — root
 *     at top, agents below.
 *   - Dot color = atom type; dot size = confidence; hover → full
 *     atom via AtomRef-style preview (reuses existing AtomRef on
 *     click to navigate).
 */
export function TimelineView() {
  const hoverCard = useHoverCard<CanonAtom>();

  const canonQ = useQuery({
    queryKey: ['canon', [], ''],
    queryFn: ({ signal }) => listCanonAtoms({}, signal),
  });
  const activitiesQ = useQuery({
    queryKey: ['activities', 500],
    queryFn: ({ signal }) => listActivities({ limit: 500 }, signal),
  });
  const principalsQ = useQuery({
    queryKey: ['principals'],
    queryFn: ({ signal }) => listPrincipals(signal),
  });

  const { rows, atomsByPrincipal, earliest, latest } = useMemo(() => {
    const principals = principalsQ.data ?? [];
    const atoms = [...(canonQ.data ?? []), ...(activitiesQ.data ?? [])];
    // Dedupe by id (canon + activities overlap — canon atoms show up
    // in both lists).
    const byId = new Map<string, CanonAtom>();
    for (const a of atoms) if (!byId.has(a.id)) byId.set(a.id, a);
    const unique = Array.from(byId.values());

    // Sort principals by hierarchy depth then id.
    const principalsById = new Map(principals.map((p) => [p.id, p]));
    const depthOf = (id: string): number => {
      let d = 0;
      let cur = principalsById.get(id);
      const seen = new Set<string>();
      while (cur?.signed_by && !seen.has(cur.id) && d < 9) {
        seen.add(cur.id);
        cur = principalsById.get(cur.signed_by);
        if (cur) d++;
      }
      return d;
    };
    const sortedPrincipals = [...principals].sort((a, b) => {
      const da = depthOf(a.id);
      const db = depthOf(b.id);
      if (da !== db) return da - db;
      return a.id.localeCompare(b.id);
    });

    // Build synthetic principals for any ids that authored atoms but
    // aren't in the principals directory (e.g. bootstrap, lag-ceo).
    const knownIds = new Set(sortedPrincipals.map((p) => p.id));
    const extras = new Set<string>();
    for (const a of unique) {
      if (!knownIds.has(a.principal_id)) extras.add(a.principal_id);
    }
    const extraRows: Principal[] = Array.from(extras).sort().map((id) => ({
      id,
      name: id,
      role: 'external',
      active: true,
      signed_by: null,
    }));

    const allRows = [...sortedPrincipals, ...extraRows];
    const byPrincipal = new Map<string, CanonAtom[]>();
    for (const a of unique) {
      const arr = byPrincipal.get(a.principal_id) ?? [];
      arr.push(a);
      byPrincipal.set(a.principal_id, arr);
    }

    // Time range = earliest atom → now (capped to 14 days window).
    let min = Infinity;
    let max = -Infinity;
    for (const a of unique) {
      const t = Date.parse(a.created_at);
      if (Number.isFinite(t)) {
        if (t < min) min = t;
        if (t > max) max = t;
      }
    }
    const now = Date.now();
    const fourteenDaysAgo = now - 14 * 24 * 60 * 60 * 1000;
    const effectiveMin = Math.max(fourteenDaysAgo, isFinite(min) ? min : now - 24 * 60 * 60 * 1000);
    const effectiveMax = Math.max(now, isFinite(max) ? max : now);

    return {
      rows: allRows.map((p) => ({ principal: p, depth: knownIds.has(p.id) ? depthOf(p.id) : 0 })),
      atomsByPrincipal: byPrincipal,
      earliest: effectiveMin,
      latest: effectiveMax,
    };
  }, [canonQ.data, activitiesQ.data, principalsQ.data]);

  const pending = canonQ.isPending || activitiesQ.isPending || principalsQ.isPending;
  const error = canonQ.error ?? activitiesQ.error ?? principalsQ.error;

  if (pending) return <LoadingState label="Loading timeline…" testId="timeline-loading" />;
  if (error) return <ErrorState title="Could not load timeline" message={(error as Error).message} testId="timeline-error" />;

  const rangeMs = Math.max(1, latest - earliest);

  /*
   * Day ticks — render a vertical gridline + label for each day in
   * the window. Gives the timeline legible chunking.
   */
  const dayMs = 24 * 60 * 60 * 1000;
  const firstDayStart = new Date(earliest);
  firstDayStart.setHours(0, 0, 0, 0);
  const days: Array<{ ts: number; label: string }> = [];
  for (let t = firstDayStart.getTime(); t <= latest; t += dayMs) {
    if (t < earliest) continue;
    days.push({ ts: t, label: new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) });
  }

  return (
    <section className={styles.view}>
      <header className={styles.head}>
        <div>
          <div className={styles.total}>{rows.length}</div>
          <div className={styles.label}>principal{rows.length === 1 ? '' : 's'} · {Array.from(atomsByPrincipal.values()).reduce((s, a) => s + a.length, 0)} atoms · last 14d</div>
        </div>
        <div className={styles.legend}>
          {(['directive', 'decision', 'preference', 'reference', 'plan', 'observation'] as const).map((k) => (
            <span key={k} className={styles.legendChip}>
              <span className={styles.legendDot} data-type={k} />
              {k}
            </span>
          ))}
        </div>
      </header>

      <div className={styles.grid}>
        <div className={styles.corner}>
          <span className={styles.cornerHint}>principal ↓ · time →</span>
        </div>
        <div className={styles.xAxis}>
          {days.map((d) => (
            <div
              key={d.ts}
              className={styles.xTick}
              style={{ left: `${((d.ts - earliest) / rangeMs) * 100}%` }}
            >
              <span className={styles.xLabel}>{d.label}</span>
            </div>
          ))}
        </div>

        <div className={styles.rows}>
          {rows.map(({ principal, depth }) => {
            const atoms = atomsByPrincipal.get(principal.id) ?? [];
            return (
              <div key={principal.id} className={styles.row} data-testid="timeline-row" data-principal-id={principal.id}>
                {/*
                 * Depth indent rides on a CSS variable instead of an
                 * inline padding-left override. The base horizontal
                 * gutter (space-4 on desktop, space-3 on mobile) is
                 * applied in CSS and the variable layers on top via
                 * calc, so depth-0 rows keep the same left gutter as
                 * the corner cell above them. See the rowLabel rule.
                 */}
                <div
                  className={styles.rowLabel}
                  style={{ '--depth-indent': depth } as React.CSSProperties}
                >
                  {depth > 0 && <span className={styles.rowIndent} aria-hidden="true">└</span>}
                  <span className={styles.rowName}>{principal.name ?? principal.id}</span>
                  <span className={styles.rowMeta}>{atoms.length}</span>
                </div>
                <div className={styles.rowLane}>
                  {atoms.map((a) => {
                    const t = Date.parse(a.created_at);
                    if (!Number.isFinite(t) || t < earliest) return null;
                    const leftPct = Math.max(0, Math.min(100, ((t - earliest) / rangeMs) * 100));
                    const size = 6 + Math.round((a.confidence ?? 0.5) * 6);
                    return (
                      <button
                        key={a.id}
                        type="button"
                        className={styles.dot}
                        data-type={a.type}
                        data-testid="timeline-dot"
                        data-atom-id={a.id}
                        style={{
                          left: `${leftPct}%`,
                          width: `${size}px`,
                          height: `${size}px`,
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setRoute(routeForAtomId(a.id), a.id);
                        }}
                        onMouseEnter={(e) => hoverCard.show(a, e.clientX, e.clientY)}
                        onMouseMove={(e) => hoverCard.updatePos(e.clientX, e.clientY)}
                        onMouseLeave={hoverCard.scheduleHide}
                        onFocus={(e) => {
                          const r = e.currentTarget.getBoundingClientRect();
                          hoverCard.show(a, r.left + r.width / 2, r.top);
                        }}
                        onBlur={hoverCard.scheduleHide}
                      >
                        <span className={styles.srOnly}>{a.id}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {rows.length > 0 && (
        <footer className={styles.foot}>
          <TimeAgo iso={new Date(earliest).toISOString()} prefix="window start" />
          <span className={styles.footSep} aria-hidden="true">→</span>
          <TimeAgo iso={new Date(latest).toISOString()} prefix="now" />
        </footer>
      )}

      {hoverCard.open && hoverCard.data && hoverCard.pos && createPortal(
        <div
          className={styles.hoverWrap}
          style={{
            top: Math.min(hoverCard.pos.y + 16, window.innerHeight - 220),
            left: Math.min(hoverCard.pos.x + 16, window.innerWidth - 380),
          }}
        >
          <AtomHoverCard
            atom={hoverCard.data}
            hint="click · open full page"
            onPointerEnter={hoverCard.cancelHide}
            onPointerLeave={hoverCard.scheduleHide}
          />
        </div>,
        document.body,
      )}
    </section>
  );
}
