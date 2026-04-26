import { useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, AlertTriangle, Archive, RefreshCw, Clock, ShieldCheck } from 'lucide-react';
import { AtomRef } from '@/components/atom-ref/AtomRef';
import { AtomGraph } from '@/components/atom-graph/AtomGraph';
import { SupersedesDiff } from '@/components/supersedes-diff/SupersedesDiff';
import { ConfidenceBar } from '@/components/confidence-bar/ConfidenceBar';
import { CopyLinkButton } from '@/components/copy-link/CopyLinkButton';
import { RawJson } from '@/components/raw-json/RawJson';
import { TimeAgo } from '@/components/time-ago/TimeAgo';
import { AttributionAuditDialog } from '@/components/attribution-audit/AttributionAuditDialog';
import { asAlternative, listReferencers, listAtomChain, listAtomCascade, reinforceAtom, markAtomStale, type CanonAtom } from '@/services/canon.service';
import { requireActorId } from '@/services/session.service';
import { useCurrentActorId } from '@/hooks/useCurrentActorId';
import { routeForAtomId, routeHref } from '@/state/router.store';
import styles from './CanonCard.module.css';

interface Props {
  readonly atom: CanonAtom;
}

export function CanonCard({ atom }: Props) {
  const [expanded, setExpanded] = useState(false);
  const tainted = Boolean(atom.taint) && atom.taint !== 'clean';
  const superseded = (atom.superseded_by?.length ?? 0) > 0;

  return (
    <article
      className={`${styles.card} ${tainted ? styles.cardTainted : ''} ${superseded ? styles.cardSuperseded : ''}`}
      data-testid="canon-card"
      data-atom-id={atom.id}
      data-atom-type={atom.type}
    >
      <header className={styles.header}>
        <span className={styles.typeBadge} data-type={atom.type}>
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
      </header>

      <p className={styles.content}>{atom.content}</p>

      <footer className={styles.footer}>
        <span className={styles.meta}>
          <span className={styles.metaLabel}>by</span> {atom.principal_id}
        </span>
        <span className={styles.metaDot} aria-hidden="true">•</span>
        <span className={styles.meta}>
          <span className={styles.metaLabel}>conf</span>
          <ConfidenceBar value={atom.confidence} compact />
        </span>
        <span className={styles.metaDot} aria-hidden="true">•</span>
        <span className={styles.meta}>
          <span className={styles.metaLabel}>layer</span> {atom.layer}
        </span>
        <span className={styles.metaDot} aria-hidden="true">•</span>
        <TimeAgo iso={atom.created_at} />
        <button
          type="button"
          className={`${styles.expand} ${expanded ? styles.expandOpen : ''}`}
          onClick={() => setExpanded((x) => !x)}
          aria-expanded={expanded}
          data-testid={`card-expand-${atom.id}`}
        >
          <ChevronDown size={14} strokeWidth={2} />
          {expanded ? 'Hide details' : 'Show details'}
        </button>
      </footer>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            className={styles.expanded}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
          >
            <div className={styles.expandedInner}>
              <DetailsPanel atom={atom} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
}

function DetailsPanel({ atom }: { atom: CanonAtom }) {
  const alternatives = atom.metadata?.alternatives_rejected ?? [];
  const whatBreaks = atom.metadata?.what_breaks_if_revisited;
  const derivedFrom = atom.provenance?.derived_from ?? [];
  const sourcePlan = typeof atom.metadata?.source_plan === 'string' ? atom.metadata.source_plan : undefined;

  return (
    <>
      <Section title="Attributes">
        <dl className={styles.attrs}>
          <AttrRow label="Created" value={formatDate(atom.created_at)} />
          {atom.last_reinforced_at && atom.last_reinforced_at !== atom.created_at && (
            <AttrRow label="Reinforced" value={formatDate(atom.last_reinforced_at)} />
          )}
          <AttrRow label="Scope" value={atom.scope ?? '—'} />
          <AttrRow label="Taint" value={atom.taint ?? 'clean'} />
          {atom.expires_at && <AttrRow label="Expires" value={formatDate(atom.expires_at)} />}
          {atom.provenance?.kind && <AttrRow label="Provenance" value={atom.provenance.kind} />}
          {sourcePlan && (
            <>
              <dt className={styles.attrLabel}>Source plan</dt>
              <dd className={styles.attrValue}><AtomRef id={sourcePlan} /></dd>
            </>
          )}
        </dl>
      </Section>

      {whatBreaks && (
        <Section title="What breaks if revisited">
          <p className={styles.sectionBody}>{whatBreaks}</p>
        </Section>
      )}

      {alternatives.length > 0 && (
        <Section title="Alternatives rejected">
          <ul className={styles.list}>
            {alternatives.map((raw, i) => {
              const alt = asAlternative(raw);
              return (
                <li key={i} className={styles.listItem}>
                  <strong className={styles.listItemTitle}>{alt.option}</strong>
                  {alt.reason && <span className={styles.listItemReason}>{alt.reason}</span>}
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {derivedFrom.length > 0 && (
        <Section title="Derived from">
          <ul className={styles.refList}>
            {derivedFrom.map((ref) => (
              <li key={ref}><AtomRef id={ref} /></li>
            ))}
          </ul>
        </Section>
      )}

      {(atom.supersedes?.length ?? 0) > 0 && (
        <Section title="Supersedes">
          <ul className={styles.refList}>
            {atom.supersedes!.map((ref) => (
              <li key={ref}><AtomRef id={ref} /></li>
            ))}
          </ul>
        </Section>
      )}

      {(atom.superseded_by?.length ?? 0) > 0 && (
        <Section title="Superseded by">
          <ul className={styles.refList}>
            {atom.superseded_by!.map((ref) => (
              <li key={ref}><AtomRef id={ref} /></li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Local graph">
        <AtomGraph atom={atom} />
      </Section>
      <ReferencedBy atomId={atom.id} />
      <WhyThisAtom atomId={atom.id} />
      <CascadeIfTainted atomId={atom.id} />
      <SupersedesDiff atom={atom} />

      <div className={styles.actionsRow}>
        <CopyLinkButton href={routeHref(routeForAtomId(atom.id), atom.id)} />
        <RawJson value={atom} testId={`raw-json-${atom.id}`} />
        <MaintenanceActions atom={atom} />
      </div>
    </>
  );
}

/*
 * Operator maintenance buttons — reinforce and mark-stale. Small
 * writable surface; no structural changes to the atom. Both actions
 * invalidate the canon + drift queries on success so the UI
 * refreshes in place.
 */
function MaintenanceActions({ atom }: { atom: CanonAtom }) {
  const [auditOpen, setAuditOpen] = useState(false);
  const qc = useQueryClient();
  /*
   * Actor id is resolved at the mutationFn call — NOT baked into a
   * literal. `requireActorId` throws loudly if the server returned
   * null (LAG_CONSOLE_ACTOR_ID unset), so a write never silently
   * attributes to a fallback identity. This is the client half of
   * `dec-console-session-identity-server-sourced` and closes the
   * CodeRabbit critical on hardcoded `'apex-agent'`.
   */
  const actorId = useCurrentActorId();
  const reinforce = useMutation({
    mutationFn: () => reinforceAtom({ id: atom.id, actor_id: requireActorId(actorId) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['canon'] });
      qc.invalidateQueries({ queryKey: ['canon.drift'] });
      qc.invalidateQueries({ queryKey: ['activities'] });
    },
  });
  const markStale = useMutation({
    mutationFn: () => markAtomStale({ id: atom.id, actor_id: requireActorId(actorId), reason: 'UI mark-stale' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['canon'] });
      qc.invalidateQueries({ queryKey: ['canon.drift'] });
      qc.invalidateQueries({ queryKey: ['activities'] });
    },
  });
  return (
    <>
      <button
        type="button"
        className={styles.maintenance}
        onClick={() => reinforce.mutate()}
        disabled={reinforce.isPending}
        data-testid={`reinforce-${atom.id}`}
        title="Mark this atom as still applying — updates last_reinforced_at"
      >
        <RefreshCw size={12} strokeWidth={2} />
        {reinforce.isSuccess ? 'reinforced' : reinforce.isPending ? 'reinforcing…' : 'reinforce'}
      </button>
      <button
        type="button"
        className={styles.maintenance}
        data-variant="warning"
        onClick={() => markStale.mutate()}
        disabled={markStale.isPending}
        data-testid={`mark-stale-${atom.id}`}
        title="Flag this atom as stale — sets expires_at to now; atom stays in canon but surfaces in the drift banner"
      >
        <Clock size={12} strokeWidth={2} />
        {markStale.isSuccess ? 'marked stale' : markStale.isPending ? 'marking…' : 'mark stale'}
      </button>
      <button
        type="button"
        className={styles.maintenance}
        onClick={() => setAuditOpen(true)}
        data-testid={`audit-${atom.id}`}
        title="Audit the principal chain + provenance — governance-native integrity check"
      >
        <ShieldCheck size={12} strokeWidth={2} />
        audit
      </button>
      <AttributionAuditDialog atom={auditOpen ? atom : null} onClose={() => setAuditOpen(false)} />
    </>
  );
}

/*
 * Reverse-reference lookup. Runs only when the parent card is
 * expanded (component is mounted lazily from the details panel).
 * TanStack Query caches per-atom-id across remounts, so reopening a
 * card that was already opened is instant.
 */
function ReferencedBy({ atomId }: { atomId: string }) {
  const query = useQuery({
    queryKey: ['atoms.references', atomId],
    queryFn: ({ signal }) => listReferencers(atomId, signal),
    staleTime: 30_000,
  });
  const refs = query.data ?? [];
  if (query.isPending || refs.length === 0) return null;
  return (
    <Section title={`Referenced by (${refs.length})`}>
      <AtomPillList atoms={refs} testIdPrefix="referenced-by" />
    </Section>
  );
}

/*
 * "Why this atom exists" — walks derived_from transitively and shows
 * the provenance chain that led to this atom. Every atom's decision
 * is the product of its ancestors; this surface makes that visible.
 */
function WhyThisAtom({ atomId }: { atomId: string }) {
  const query = useQuery({
    queryKey: ['atoms.chain', atomId],
    queryFn: ({ signal }) => listAtomChain(atomId, 5, signal),
    staleTime: 30_000,
  });
  const chain = query.data ?? [];
  if (query.isPending || chain.length === 0) return null;
  return (
    <Section title={`Why this atom exists (${chain.length} ancestor${chain.length === 1 ? '' : 's'})`}>
      <AtomPillList atoms={chain} testIdPrefix="provenance-chain" />
    </Section>
  );
}

/*
 * "If compromised, these would taint" — walks the reverse derived_from
 * graph showing the blast radius if this atom's integrity is lost.
 * Governance-specific wow: hover a high-authority atom and see the
 * downstream consequences of a compromise.
 */
function CascadeIfTainted({ atomId }: { atomId: string }) {
  const query = useQuery({
    queryKey: ['atoms.cascade', atomId],
    queryFn: ({ signal }) => listAtomCascade(atomId, 5, signal),
    staleTime: 30_000,
  });
  const cascade = query.data ?? [];
  if (query.isPending || cascade.length === 0) return null;
  return (
    <Section title={`If compromised, taint cascades to (${cascade.length})`}>
      <AtomPillList atoms={cascade} testIdPrefix="cascade" />
    </Section>
  );
}

function AtomPillList({
  atoms,
  testIdPrefix,
}: {
  atoms: ReadonlyArray<CanonAtom>;
  testIdPrefix: string;
}) {
  return (
    <ul className={styles.refList} data-testid={testIdPrefix}>
      {atoms.map((a) => (
        <li key={a.id} className={styles.referencer}>
          <span className={styles.referencerType} data-type={a.type}>{a.type}</span>
          <AtomRef id={a.id} />
        </li>
      ))}
    </ul>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={styles.section}>
      <h4 className={styles.sectionTitle}>{title}</h4>
      {children}
    </div>
  );
}

function AttrRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className={styles.attrLabel}>{label}</dt>
      <dd className={mono ? styles.attrValueMono : styles.attrValue}>{value}</dd>
    </>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
