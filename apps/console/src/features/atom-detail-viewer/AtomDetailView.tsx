import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Archive } from 'lucide-react';
import { AtomRef } from '@/components/atom-ref/AtomRef';
import { ConfidenceBar } from '@/components/confidence-bar/ConfidenceBar';
import { CopyLinkButton } from '@/components/copy-link/CopyLinkButton';
import { RawJson } from '@/components/raw-json/RawJson';
import { TimeAgo } from '@/components/time-ago/TimeAgo';
import { FocusBanner } from '@/components/focus-banner/FocusBanner';
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/state-display/StateDisplay';
import { InlineError } from '@/components/state-display/InlineError';
import { subBlockState } from '@/components/state-display/subBlockState';
import { toErrorMessage } from '@/services/errors';
import {
  getAtomById,
  listReferencers,
  type AnyAtom,
} from '@/services/atoms.service';
import { atomTypeTone } from '@/features/atom-type-tones/tones';
import {
  routeForAtomId,
  routeHref,
  setRoute,
} from '@/state/router.store';
import { Section, AttrRow } from './Section';
import { pickRenderer } from './renderers/dispatch';
import { formatDate } from './renderers/helpers';
import styles from './AtomDetailView.module.css';

/**
 * Generic atom-detail viewer.
 *
 * Renders ANY atom in the substrate (plan, pipeline, pipeline-stage-event,
 * pipeline-audit-finding, brainstorm-output, spec-output, review-report,
 * dispatch-record, actor-message, operator-intent, agent-session,
 * agent-turn, observation, pr-fix-observation, ...) via a type-dispatch
 * table; unknown types fall back to the generic renderer so the
 * operator always sees the content + metadata + provenance even for
 * brand-new substrate types.
 *
 * Page layout (top to bottom):
 *   1. Focus banner with copyable id and "back to native view" affordance
 *   2. Header pill row + title + subtitle (type chip, taint, supersession)
 *   3. Attributes grid (principal, layer, scope, confidence, dates)
 *   4. Type-specific renderer body (the dispatched component)
 *   5. Provenance: derived_from chain
 *   6. Supersedes / Superseded by chains
 *   7. Referenced by (reverse-link)
 *   8. Raw JSON power-user button + copy-link
 *
 * Read-only per the console v1 contract; the maintenance actions
 * (reinforce, mark-stale) live on the L3-canon CanonCard, not here.
 */
export function AtomDetailView({ atomId }: { atomId: string }) {
  const query = useQuery({
    queryKey: ['atoms.get', atomId],
    queryFn: ({ signal }) => getAtomById(atomId, signal),
    /*
     * Atoms are immutable once written (the substrate appends; it
     * does not in-place edit). 30s staleness keeps the SSE-driven
     * refetch from thrashing without blocking a fresh write.
     */
    staleTime: 30_000,
  });

  if (query.isPending) {
    return <LoadingState label="Loading atom..." testId="atom-detail-loading" />;
  }
  if (query.isError) {
    return (
      <ErrorState
        title="Could not load atom"
        message={(query.error as Error).message}
        testId="atom-detail-error"
      />
    );
  }
  if (!query.data) {
    return (
      <EmptyState
        title="Atom not found"
        detail={<><code>{atomId}</code> is not in the atom store.</>}
        testId="atom-detail-empty"
        action={
          <button
            type="button"
            onClick={() => setRoute('activities')}
            data-testid="atom-detail-back-to-activities"
          >
            Back to activities
          </button>
        }
      />
    );
  }

  return <AtomDetailBody atom={query.data} />;
}

function AtomDetailBody({ atom }: { atom: AnyAtom }) {
  const tainted = Boolean(atom.taint) && atom.taint !== 'clean';
  const superseded = (atom.superseded_by?.length ?? 0) > 0;
  const Renderer = pickRenderer(atom.type, atom.metadata);
  const tone = atomTypeTone(atom.type);
  const subtitle = oneLineSummary(atom);

  return (
    <section className={styles.view} data-testid="atom-detail-view" data-atom-type={atom.type} data-atom-id={atom.id}>
      <FocusBanner
        label="Atom"
        id={atom.id}
        onClear={() => {
          /*
           * Route the "back to native view" affordance to the atom's
           * native surface (canon -> /canon/<id>, plan -> /plans/<id>,
           * pipeline -> /pipelines/<id>, activities -> /activities/<id>,
           * etc.) when one exists. routeForAtomId returns 'atom' as
           * the generic-fallback bucket, which would leave the
           * operator on the same /atom/<id> page they are already
           * viewing -- not a "clear" -- so we treat that as the "no
           * native view" case and send them to the activity feed
           * (id-less) where focus mode handles arbitrary atom ids.
           */
          const native = routeForAtomId(atom.id);
          if (native === 'atom') {
            setRoute('activities');
          } else {
            setRoute(native, atom.id);
          }
        }}
      />

      <div className={styles.head}>
        <div className={styles.headRow}>
          <span
            className={styles.typeChip}
            data-testid="atom-detail-type-chip"
            data-atom-type={atom.type}
            style={{ color: tone }}
          >
            {atom.type}
          </span>
          <code className={styles.id}>{atom.id}</code>
          {tainted && (
            <span className={styles.statusPill} data-variant="danger" title="Tainted">
              <AlertTriangle size={12} strokeWidth={2.25} aria-hidden="true" />
              {atom.taint}
            </span>
          )}
          {superseded && (
            <span className={styles.statusPill} data-variant="warning" title="Superseded">
              <Archive size={12} strokeWidth={2.25} aria-hidden="true" />
              superseded
            </span>
          )}
          {atom.plan_state && (
            <span
              className={styles.statusPill}
              data-variant="info"
              data-testid="atom-detail-plan-state"
            >
              plan: {atom.plan_state}
            </span>
          )}
          {atom.pipeline_state && (
            <span
              className={styles.statusPill}
              data-variant="info"
              data-testid="atom-detail-pipeline-state"
            >
              pipeline: {atom.pipeline_state}
            </span>
          )}
        </div>

        {subtitle && <p className={styles.subtitle}>{subtitle}</p>}

        <div className={styles.metaRow}>
          <span className={styles.meta}>
            <span className={styles.metaLabel}>by</span>
            <code>{atom.principal_id}</code>
          </span>
          <span className={styles.metaDot} aria-hidden="true">{'\u00B7'}</span>
          <span className={styles.meta}>
            <span className={styles.metaLabel}>layer</span> {atom.layer}
          </span>
          <span className={styles.metaDot} aria-hidden="true">{'\u00B7'}</span>
          <span className={styles.meta}>
            <span className={styles.metaLabel}>conf</span>
            <ConfidenceBar value={atom.confidence} compact />
          </span>
          <span className={styles.metaDot} aria-hidden="true">{'\u00B7'}</span>
          <TimeAgo iso={atom.created_at} />
        </div>
      </div>

      <Section title="Attributes" testId="atom-detail-attributes">
        <dl className={styles.attrs}>
          <AttrRow label="Created" value={formatDate(atom.created_at)} />
          {atom.last_reinforced_at && atom.last_reinforced_at !== atom.created_at && (
            <AttrRow label="Reinforced" value={formatDate(atom.last_reinforced_at)} />
          )}
          <AttrRow label="Scope" value={atom.scope ?? '--'} />
          <AttrRow label="Taint" value={atom.taint ?? 'clean'} />
          {atom.expires_at && (
            <AttrRow label="Expires" value={formatDate(atom.expires_at)} />
          )}
          {atom.provenance?.kind && (
            <AttrRow label="Provenance kind" value={atom.provenance.kind} />
          )}
          {atom.signals?.validation_status && (
            <AttrRow
              label="Validation status"
              value={atom.signals.validation_status}
              testId="atom-detail-validation-status"
            />
          )}
          {atom.schema_version !== undefined && (
            <AttrRow label="Schema version" value={String(atom.schema_version)} />
          )}
        </dl>
      </Section>

      <Renderer atom={atom} />

      <RefList
        title="Derived from"
        items={atom.provenance?.derived_from ?? []}
        testId="atom-detail-derived-from"
      />
      <RefList
        title="Supersedes"
        items={atom.supersedes ?? []}
        testId="atom-detail-supersedes"
      />
      <RefList
        title="Superseded by"
        items={atom.superseded_by ?? []}
        testId="atom-detail-superseded-by"
      />
      <SignalsBlock atom={atom} />
      <ReferencedByBlock atomId={atom.id} />

      <div className={styles.actionsRow}>
        {/*
          The share button copies the actual page permalink the
          operator is viewing (`/atom/<id>`), not a route-rewriting
          variant. Earlier this called routeHref(routeForAtomId(...))
          which could yield `/canon/<id>` or `/plans/<id>` from the
          atom-detail page, surfacing a different surface than the
          one the user shared from. Hardcoding the 'atom' route keeps
          the link semantics aligned with the page.
        */}
        <CopyLinkButton href={routeHref('atom', atom.id)} />
        <RawJson value={atom} testId={`atom-detail-raw-json`} />
      </div>
    </section>
  );
}

/*
 * Subtitle helper: pick the first line of content (or the metadata
 * title for plan atoms) so the operator gets a one-glance read of
 * what they're looking at without expanding any block.
 */
function oneLineSummary(atom: AnyAtom): string | null {
  const meta = atom.metadata;
  const metaTitle
    = meta && typeof (meta as { title?: unknown }).title === 'string'
      ? (meta as { title: string }).title
      : null;
  if (metaTitle) return metaTitle.slice(0, 240);
  const content = atom.content ?? '';
  const firstHeading = content.match(/^#+\s+(.+)$/m)?.[1];
  if (firstHeading) return firstHeading.slice(0, 240);
  const firstNonBlank = content.split('\n').find((l) => l.trim().length > 0);
  if (firstNonBlank) return firstNonBlank.slice(0, 240);
  return null;
}

/*
 * RefList: Section + ul of AtomRef chips for any "list of atom ids"
 * block (derived_from, supersedes, superseded_by, agrees_with,
 * conflicts_with, referenced_by). Renders nothing when the list is
 * empty so callers unconditionally pass the array. Title gets a count
 * appended so the header reads "Derived from (3)" without each caller
 * doing the math.
 *
 * `inline=true` renders an h4 + ul WITHOUT the surrounding Section
 * chrome so SignalsBlock can stack two RefLists under one Signals
 * heading without nesting two Section borders.
 *
 * Per canon `dev-dry-extract-at-second-duplication`: the original
 * AtomDetailView shipped four near-identical copies of the same
 * {Section + ul.refList + map(li > AtomRef)} markup; this extraction
 * collapses them into one helper so future additions (e.g.
 * plan.delegated_to, signals.endorses) inherit the same shape +
 * test-id convention without copy-paste drift.
 */
function RefList({
  title,
  items,
  testId,
  inline,
}: {
  readonly title: string;
  readonly items: ReadonlyArray<string>;
  readonly testId?: string;
  readonly inline?: boolean;
}) {
  if (items.length === 0) return null;
  const titleWithCount = `${title} (${items.length})`;
  const list = (
    <ul className={styles.refList}>
      {items.map((id) => (
        <li key={id} className={styles.refItem}>
          <AtomRef id={id} />
        </li>
      ))}
    </ul>
  );
  if (inline) {
    return (
      <div {...(testId ? { 'data-testid': testId } : {})}>
        <h4 className={styles.attrLabel}>{titleWithCount}</h4>
        {list}
      </div>
    );
  }
  return (
    <Section title={titleWithCount} {...(testId ? { testId } : {})}>
      {list}
    </Section>
  );
}

function SignalsBlock({ atom }: { atom: AnyAtom }) {
  const agreesWith = atom.signals?.agrees_with ?? [];
  const conflictsWith = atom.signals?.conflicts_with ?? [];
  if (agreesWith.length === 0 && conflictsWith.length === 0) return null;
  return (
    <Section title="Signals" testId="atom-detail-signals">
      <RefList
        title="Agrees with"
        items={agreesWith}
        testId="atom-detail-agrees-with"
        inline
      />
      <RefList
        title="Conflicts with"
        items={conflictsWith}
        testId="atom-detail-conflicts-with"
        inline
      />
    </Section>
  );
}

function ReferencedByBlock({ atomId }: { atomId: string }) {
  const query = useQuery({
    queryKey: ['atoms.references', atomId],
    queryFn: ({ signal }) => listReferencers(atomId, signal),
    staleTime: 30_000,
  });
  /*
   * `listReferencers` returns the wider `AnyAtom[]` so non-canon
   * referencers (plans, pipeline outputs, intents, observations,
   * pr-fix-observations, ...) surface here instead of being silently
   * filtered. Earlier this typed the result as `CanonAtom[]` and
   * imported `listReferencers` from canon.service.ts, which hid every
   * non-L3 referencer from the operator's view.
   */
  const refs: ReadonlyArray<AnyAtom> = query.data ?? [];
  /*
   * Earlier this short-circuited on `query.isPending || refs.length
   * === 0`, silently absorbing isError as "no referencers". A failed
   * fetch of the reverse-link block was indistinguishable from an
   * atom that legitimately has zero referencers. The InlineError
   * branch surfaces the failure quietly inside a labeled section so
   * the operator sees that the surface is partial; the rest of the
   * atom-detail page (header, attributes, type-renderer body) renders
   * normally because they hang off independent queries.
   */
  const state = subBlockState(query, refs.length === 0);
  if (state.kind === 'pending' || state.kind === 'empty') return null;
  if (state.kind === 'error') {
    return (
      <Section title="Referenced by" testId="atom-detail-referenced-by">
        <InlineError
          message={toErrorMessage(state.error)}
          testId="atom-detail-referenced-by-error"
        />
      </Section>
    );
  }
  return (
    <RefList
      title="Referenced by"
      items={refs.map((a) => a.id)}
      testId="atom-detail-referenced-by"
    />
  );
}
