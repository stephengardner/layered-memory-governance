import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Send, CheckCircle2 } from 'lucide-react';
import { proposeAtom, type AtomType } from '@/services/canon.service';
import { requireActorId } from '@/services/session.service';
import { useCurrentActorId } from '@/hooks/useCurrentActorId';
import styles from './ProposeAtomDialog.module.css';

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
}

const TYPES: ReadonlyArray<{ value: AtomType; label: string; hint: string }> = [
  { value: 'directive', label: 'Directive', hint: 'An enforceable rule; a reviewer rejects PRs that break it' },
  { value: 'decision', label: 'Decision', hint: 'A design choice that will govern future work' },
  { value: 'preference', label: 'Preference', hint: 'A tunable default; overridable per-tenant' },
  { value: 'reference', label: 'Reference', hint: 'A pointer to authoritative external docs' },
];

/**
 * Propose a new canon atom from the UI.
 *
 * CANON-CRITICAL: this is NOT a direct L3 write. The backend writes
 * at L0 with `validation_status: pending_review`. L3 promotion still
 * requires the existing human-approval flow per
 * `inv-l3-requires-human` + `pref-l3-threshold-default`. This dialog
 * is intake — it opens a new door into the governance pipeline, it
 * does not short-circuit the gate.
 *
 * The proposer_id is resolved at mutation time from
 * `useCurrentActorId`, which reads from the server's
 * `LAG_CONSOLE_ACTOR_ID` config. `requireActorId` throws loudly if
 * unset — proposal writes never silently attribute to a fallback
 * identity (`dev-framework-mechanism-only` canon).
 */
export function ProposeAtomDialog({ open, onClose }: Props) {
  const [content, setContent] = useState('');
  const [type, setType] = useState<AtomType>('decision');
  const [confidence, setConfidence] = useState(0.8);
  const qc = useQueryClient();
  const actorId = useCurrentActorId();

  const mutation = useMutation({
    mutationFn: (params: { content: string; type: AtomType; confidence: number }) =>
      proposeAtom({ ...params, proposer_id: requireActorId(actorId) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['canon'] });
      qc.invalidateQueries({ queryKey: ['activities'] });
    },
  });

  // Reset on open so the form is clean between uses. Don't clear on
  // close — if the user closes mid-write we might want to preserve
  // draft later; for now, explicit re-open is fresh.
  useEffect(() => {
    if (open) {
      setContent('');
      setType('decision');
      setConfidence(0.8);
      mutation.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Esc to close. Only while open.
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [open, onClose]);

  const canSubmit = content.trim().length >= 16 && !mutation.isPending;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className={styles.backdrop}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            onClick={onClose}
          />
          <div className={styles.wrap}>
            <motion.div
              className={styles.dialog}
              initial={{ opacity: 0, y: 14, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
              role="dialog"
              aria-labelledby="propose-title"
              data-testid="propose-dialog"
            >
              <header className={styles.head}>
                <h2 id="propose-title" className={styles.title}>Propose a new atom</h2>
                <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
                  <X size={16} strokeWidth={2} />
                </button>
              </header>

              <p className={styles.hint}>
                Writes at <code>layer: L0</code> with{' '}
                <code>validation_status: pending_review</code>. L3 promotion
                stays gated by the existing human-approval flow.
              </p>

              {mutation.isSuccess ? (
                <div className={styles.success} data-testid="propose-success">
                  <CheckCircle2 size={32} strokeWidth={1.75} />
                  <h3>Proposed</h3>
                  <p><code>{mutation.data?.id}</code></p>
                  <p className={styles.successDetail}>
                    It's now in the Activities feed. Promote to L3 via the canonical
                    approval flow when it's ready.
                  </p>
                  <button type="button" className={styles.primaryBtn} onClick={onClose}>
                    Done
                  </button>
                </div>
              ) : (
                <form
                  className={styles.form}
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!canSubmit) return;
                    mutation.mutate({ content: content.trim(), type, confidence });
                  }}
                >
                  <label className={styles.field}>
                    <span className={styles.label}>Type</span>
                    <div className={styles.typeGrid}>
                      {TYPES.map((t) => (
                        <button
                          key={t.value}
                          type="button"
                          className={`${styles.typeBtn} ${type === t.value ? styles.typeBtnActive : ''}`}
                          onClick={() => setType(t.value)}
                          data-testid={`propose-type-${t.value}`}
                        >
                          <span className={styles.typeLabel}>{t.label}</span>
                          <span className={styles.typeHint}>{t.hint}</span>
                        </button>
                      ))}
                    </div>
                  </label>

                  <label className={styles.field}>
                    <span className={styles.label}>Content</span>
                    <textarea
                      className={styles.textarea}
                      value={content}
                      onChange={(e) => setContent(e.target.value)}
                      placeholder="State the rule, decision, or preference in full. Future reviewers will cite this text."
                      rows={6}
                      data-testid="propose-content"
                    />
                    <span className={styles.fieldFoot}>
                      {content.trim().length}/16+ chars
                    </span>
                  </label>

                  <label className={styles.field}>
                    <span className={styles.label}>
                      Confidence <span className={styles.confValue}>{confidence.toFixed(2)}</span>
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={confidence}
                      onChange={(e) => setConfidence(parseFloat(e.target.value))}
                      className={styles.range}
                      data-testid="propose-confidence"
                    />
                    <span className={styles.fieldFoot}>
                      Below 0.7 will surface in the drift banner as low-confidence.
                    </span>
                  </label>

                  {mutation.isError && (
                    <div className={styles.error}>
                      {(mutation.error as Error).message}
                    </div>
                  )}

                  <div className={styles.actions}>
                    <button type="button" className={styles.ghostBtn} onClick={onClose}>
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className={styles.primaryBtn}
                      disabled={!canSubmit}
                      data-testid="propose-submit"
                    >
                      <Send size={14} strokeWidth={2} />
                      {mutation.isPending ? 'Proposing…' : 'Propose'}
                    </button>
                  </div>
                </form>
              )}
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
