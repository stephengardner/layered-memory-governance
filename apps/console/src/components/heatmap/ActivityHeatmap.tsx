import { useMemo } from 'react';
import styles from './ActivityHeatmap.module.css';

interface Props {
  readonly atoms: ReadonlyArray<{ readonly created_at: string }>;
  readonly weeks?: number;
}

/**
 * GitHub-contributions-style heatmap. Pure CSS grid with tone-per-
 * atom-count squares. Lets the operator scan at a glance when the
 * substrate was active — dense stretches mean a workstream lived,
 * cold stretches mean the governance graph was idle.
 *
 * Grid is weeks × 7 days (M…S rendered top-to-bottom inside each
 * column). Most recent week is the rightmost column; current day
 * is the bottom-right cell.
 */
export function ActivityHeatmap({ atoms, weeks = 12 }: Props) {
  const cells = useMemo(() => buildGrid(atoms, weeks), [atoms, weeks]);
  const max = Math.max(1, ...cells.flat().map((c) => c?.count ?? 0));

  return (
    <div className={styles.wrap} data-testid="activity-heatmap">
      <div className={styles.grid} style={{ gridTemplateColumns: `repeat(${weeks}, 1fr)` }}>
        {cells.map((col, x) => (
          <div key={x} className={styles.col}>
            {col.map((cell, y) => (
              <span
                key={y}
                className={styles.cell}
                data-tone={toneFor(cell?.count ?? 0, max)}
                title={cell ? `${cell.count} atom${cell.count === 1 ? '' : 's'} on ${cell.label}` : ''}
              />
            ))}
          </div>
        ))}
      </div>
      <div className={styles.legend}>
        <span className={styles.legendLabel}>less</span>
        <span className={styles.cell} data-tone="0" />
        <span className={styles.cell} data-tone="1" />
        <span className={styles.cell} data-tone="2" />
        <span className={styles.cell} data-tone="3" />
        <span className={styles.cell} data-tone="4" />
        <span className={styles.legendLabel}>more</span>
      </div>
    </div>
  );
}

type Cell = { count: number; label: string } | null;

function buildGrid(
  atoms: ReadonlyArray<{ created_at: string }>,
  weeks: number,
): ReadonlyArray<ReadonlyArray<Cell>> {
  const counts = new Map<string, number>();
  for (const a of atoms) {
    const key = dayKey(a.created_at);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Start on Monday of the earliest visible week.
  const start = new Date(today);
  start.setDate(start.getDate() - ((weeks - 1) * 7 + ((today.getDay() + 6) % 7)));

  const grid: Cell[][] = [];
  for (let w = 0; w < weeks; w++) {
    const col: Cell[] = [];
    for (let d = 0; d < 7; d++) {
      const cursor = new Date(start);
      cursor.setDate(start.getDate() + w * 7 + d);
      if (cursor > today) {
        col.push(null);
        continue;
      }
      const key = isoKey(cursor);
      col.push({ count: counts.get(key) ?? 0, label: cursor.toDateString() });
    }
    grid.push(col);
  }
  return grid;
}

function dayKey(iso: string): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return isoKey(new Date(t));
}

function isoKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toneFor(count: number, max: number): string {
  if (count === 0) return '0';
  const ratio = count / max;
  if (ratio > 0.75) return '4';
  if (ratio > 0.5) return '3';
  if (ratio > 0.25) return '2';
  return '1';
}
