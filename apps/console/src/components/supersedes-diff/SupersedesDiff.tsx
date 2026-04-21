import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, GitCompare } from 'lucide-react';
import { listAtomChain, type CanonAtom } from '@/services/canon.service';
import styles from './SupersedesDiff.module.css';

interface Props {
  readonly atom: CanonAtom;
}

/**
 * Side-by-side diff for an atom that supersedes a prior version.
 * Fetches each superseded predecessor and lays their content next
 * to the current atom's content. Line-level diff via a minimal
 * longest-common-subsequence computation — no external diff lib.
 *
 * Only renders if `supersedes` is non-empty.
 */
export function SupersedesDiff({ atom }: Props) {
  const [open, setOpen] = useState(false);
  const sups = atom.supersedes ?? [];

  if (sups.length === 0) return null;

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={`${styles.toggle} ${open ? styles.toggleOpen : ''}`}
        onClick={() => setOpen((x) => !x)}
        aria-expanded={open}
        data-testid={`supersedes-diff-${atom.id}`}
      >
        <GitCompare size={14} strokeWidth={2} />
        {open ? 'Hide diff' : `Diff vs previous (${sups.length})`}
        <ChevronDown size={12} strokeWidth={2} className={styles.chevron} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className={styles.body}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
          >
            {sups.map((prevId) => (
              <DiffPair key={prevId} current={atom} previousId={prevId} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function DiffPair({ current, previousId }: { current: CanonAtom; previousId: string }) {
  // Reuse the chain fetch (depth 0 returns just the predecessor).
  const query = useQuery({
    queryKey: ['atoms.chain.single', previousId],
    queryFn: ({ signal }) => listAtomChain(previousId, 0, signal),
    staleTime: 60_000,
  });
  const previous = query.data?.find((a) => a.id === previousId) ?? null;
  const diff = useMemo(() => lineDiff(previous?.content ?? '', current.content), [previous, current]);

  if (query.isPending) return <div className={styles.pending}>Loading {previousId}…</div>;
  if (!previous) return <div className={styles.missing}>Previous atom <code>{previousId}</code> not found</div>;

  return (
    <div className={styles.pair}>
      <div className={styles.pairHead}>
        <code className={styles.before}>before — {previousId}</code>
        <code className={styles.after}>after — {current.id}</code>
      </div>
      <div className={styles.columns}>
        <pre className={styles.col}>
          {diff.map((line, i) => (
            <span key={i} className={styles[`line_${line.a}`]}>{line.text + '\n'}</span>
          ))}
        </pre>
        <pre className={styles.col}>
          {diff.map((line, i) => (
            <span key={i} className={styles[`line_${line.b}`]}>{line.text + '\n'}</span>
          ))}
        </pre>
      </div>
    </div>
  );
}

type LineTag = 'same' | 'changed' | 'removed' | 'added' | 'empty';
type DiffRow = { text: string; a: LineTag; b: LineTag };

function lineDiff(a: string, b: string): DiffRow[] {
  // Classic LCS diff on lines.
  const A = a.split('\n');
  const B = b.split('\n');
  const lcs: number[][] = Array.from({ length: A.length + 1 }, () => Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) {
    for (let j = B.length - 1; j >= 0; j--) {
      lcs[i]![j] = A[i] === B[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) {
      rows.push({ text: A[i]!, a: 'same', b: 'same' });
      i++; j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      rows.push({ text: A[i]!, a: 'removed', b: 'empty' });
      i++;
    } else {
      rows.push({ text: B[j]!, a: 'empty', b: 'added' });
      j++;
    }
  }
  while (i < A.length) { rows.push({ text: A[i++]!, a: 'removed', b: 'empty' }); }
  while (j < B.length) { rows.push({ text: B[j++]!, a: 'empty', b: 'added' }); }
  return rows;
}
