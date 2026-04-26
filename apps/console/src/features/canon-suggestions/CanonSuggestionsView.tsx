import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { Copy, Check } from 'lucide-react';
import {
  listCanonSuggestions,
  buildTriageCommand,
  type CanonSuggestion,
  type CanonSuggestionReviewState,
} from '@/services/canon-suggestions.service';
import { LoadingState, ErrorState, EmptyState } from '@/components/state-display/StateDisplay';
import { StatsHeader } from '@/components/stats-header/StatsHeader';
import styles from './CanonSuggestionsView.module.css';

const STATE_TABS: ReadonlyArray<{ id: CanonSuggestionReviewState; label: string }> = [
  { id: 'pending', label: 'Pending' },
  { id: 'promoted', label: 'Promoted' },
  { id: 'dismissed', label: 'Dismissed' },
  { id: 'deferred', label: 'Deferred' },
];

/**
 * Canon Suggestions panel. Read-only by design (apps/console v1) — the
 * three action buttons COPY a CLI command to clipboard for the operator
 * to run in their terminal. The actual mutation lives in
 * `scripts/canon-suggest-triage.mjs`. The console never writes the
 * promotion; preserves `inv-l3-requires-human` end-to-end.
 *
 * Filter tabs let the operator scan promoted/dismissed/deferred for
 * audit; default is `pending` (the inbox).
 */
export function CanonSuggestionsView() {
  const [reviewState, setReviewState] = useState<CanonSuggestionReviewState>('pending');

  const query = useQuery({
    queryKey: ['canon-suggestions', reviewState],
    queryFn: ({ signal }) => listCanonSuggestions({ review_state: reviewState }, signal),
  });

  const items = query.data ?? [];

  return (
    <section className={styles.viewer} aria-busy={query.isFetching}>
      <p className={styles.intro}>
        <strong>Canon scout</strong> writes agent-observed L1 atoms suggesting canon-quality
        directives, preferences, or references it noticed in operator chat. <strong>This panel
        never writes canon</strong> — promote, dismiss, or defer via the CLI hint copied below.
        Promotion still goes through <code>scripts/decide.mjs</code>, gated by the operator.
      </p>

      <div className={styles.toolbar} role="tablist" aria-label="Filter by review state">
        {STATE_TABS.map((tab) => (
          <button
            key={tab.id}
            className={styles.stateButton}
            data-active={tab.id === reviewState ? 'true' : 'false'}
            data-testid={`canon-suggestions-tab-${tab.id}`}
            onClick={() => setReviewState(tab.id)}
            type="button"
            role="tab"
            aria-selected={tab.id === reviewState}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {query.isPending && <LoadingState label="Loading suggestions…" testId="canon-suggestions-loading" />}
      {query.isError && (
        <ErrorState
          title="Could not load suggestions"
          message={(query.error as Error).message}
          testId="canon-suggestions-error"
        />
      )}

      {query.isSuccess && items.length === 0 && (
        <EmptyState
          title={`No ${reviewState} suggestions`}
          detail={
            reviewState === 'pending'
              ? 'Run `node scripts/canon-scout-sweep.mjs --from-text "..."` to seed one.'
              : 'Switch tabs to view suggestions in another state.'
          }
          testId="canon-suggestions-empty"
        />
      )}

      {query.isSuccess && items.length > 0 && (
        <StatsHeader
          total={items.length}
          label={`suggestion${items.length === 1 ? '' : 's'}`}
          detail={`review_state: ${reviewState}`}
        />
      )}

      <motion.div className={styles.list} layout>
        <AnimatePresence mode="popLayout">
          {items.map((s) => (
            <motion.div
              key={s.id}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
            >
              <SuggestionCard suggestion={s} />
            </motion.div>
          ))}
        </AnimatePresence>
      </motion.div>
    </section>
  );
}

function confidenceTier(c: number): 'low' | 'medium' | 'high' {
  if (c >= 0.8) return 'high';
  if (c >= 0.5) return 'medium';
  return 'low';
}

interface SuggestionCardProps {
  readonly suggestion: CanonSuggestion;
}

function SuggestionCard({ suggestion }: SuggestionCardProps) {
  const meta = suggestion.metadata;
  const tier = confidenceTier(meta.confidence);
  const [copiedAction, setCopiedAction] = useState<'promote' | 'dismiss' | 'defer' | null>(null);
  const [hintAction, setHintAction] = useState<'promote' | 'dismiss' | 'defer'>('promote');

  const cliCommand = useMemo(
    () => buildTriageCommand(suggestion, hintAction),
    [suggestion, hintAction],
  );

  const onAction = async (action: 'promote' | 'dismiss' | 'defer') => {
    setHintAction(action);
    try {
      await navigator.clipboard.writeText(buildTriageCommand(suggestion, action));
      setCopiedAction(action);
      window.setTimeout(() => setCopiedAction((cur) => (cur === action ? null : cur)), 1800);
    } catch {
      // Clipboard may be unavailable (test env, insecure context). The
      // CLI hint below is selectable via user-select:all so the operator
      // can manually copy. Don't surface an error toast for this — the
      // CLI hint stays visible regardless.
    }
  };

  return (
    <article
      className={styles.card}
      data-testid="canon-suggestion-card"
      data-atom-id={suggestion.id}
      data-suggested-id={meta.suggested_id}
    >
      <header className={styles.cardHeader}>
        <span className={styles.typeBadge} data-type={meta.suggested_type}>
          {meta.suggested_type}
        </span>
        <code className={styles.suggestedId} data-testid="canon-suggestion-id">
          {meta.suggested_id}
        </code>
        <span
          className={styles.confidencePill}
          data-tier={tier}
          title={`scout confidence ${meta.confidence.toFixed(2)}`}
        >
          {tier} confidence
        </span>
      </header>

      <p className={styles.proposedContent}>{meta.proposed_content}</p>

      <pre className={styles.chatExcerpt} aria-label="Operator chat excerpt that triggered this suggestion">
        {meta.chat_excerpt}
      </pre>

      <div className={styles.actions}>
        <button
          className={styles.actionButton}
          data-variant="primary"
          data-testid="canon-suggestion-promote"
          onClick={() => onAction('promote')}
          type="button"
        >
          {copiedAction === 'promote' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          Promote
          {copiedAction === 'promote' && <span className={styles.copied}>copied</span>}
        </button>
        <button
          className={styles.actionButton}
          data-testid="canon-suggestion-dismiss"
          onClick={() => onAction('dismiss')}
          type="button"
        >
          {copiedAction === 'dismiss' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          Dismiss
          {copiedAction === 'dismiss' && <span className={styles.copied}>copied</span>}
        </button>
        <button
          className={styles.actionButton}
          data-testid="canon-suggestion-defer"
          onClick={() => onAction('defer')}
          type="button"
        >
          {copiedAction === 'defer' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          Defer
          {copiedAction === 'defer' && <span className={styles.copied}>copied</span>}
        </button>
      </div>

      <pre className={styles.cliHint} data-testid="canon-suggestion-cli-hint">{cliCommand}</pre>

      <div className={styles.metaRow}>
        <span>by <code>{suggestion.principal_id}</code></span>
        <span>atom <code>{suggestion.id}</code></span>
        <span>created {new Date(suggestion.created_at).toLocaleString()}</span>
        {meta.derived_canon_id && (
          <span>promoted to <code>{meta.derived_canon_id}</code></span>
        )}
      </div>
    </article>
  );
}
