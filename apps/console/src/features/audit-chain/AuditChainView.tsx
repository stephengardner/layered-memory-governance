import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, GitBranch, Sparkles } from 'lucide-react';
import { TimeAgo } from '@/components/time-ago/TimeAgo';
import { InlineError } from '@/components/state-display/InlineError';
import { atomTypeTone } from '@/features/atom-type-tones/tones';
import {
  routeForAtomId,
  routeHref,
  setRoute,
} from '@/state/router.store';
import { toErrorMessage } from '@/services/errors';
import {
  getAuditChain,
  type AuditChainResult,
} from '@/services/atoms.service';
import type { AnyAtom } from '@/services/atoms.service';
import { computeAuditChainLayout, type AuditChainLayout } from './layout';
import styles from './AuditChainView.module.css';

interface Props {
  readonly atomId: string;
  /**
   * If supplied, sets the panel default-open state. Atom-detail
   * mounts the panel collapsed by default to keep the page scan-
   * friendly on mobile; tests may pass `defaultOpen` to force the
   * body open without a click. The seed atom is always emitted at
   * index 0 of the response so a "where is the current atom" anchor
   * is unambiguous regardless of open/closed state.
   */
  readonly defaultOpen?: boolean;
}

/**
 * Audit-chain view: visualizes the provenance.derived_from graph for
 * the seed atom as a vertical timeline, with the seed at the top and
 * ancestors flowing downward. Each node is a clickable card showing
 * type, principal, age, and (when present) plan_state / pipeline_state
 * pill so the operator can scan the chain in one read.
 *
 * Why a timeline rather than a horizontal tree:
 *   - Mobile-first per canon `dev-mobile-first`: 390px wide doesn't
 *     fit a meaningful horizontal tree without overflow scroll, and
 *     "horizontal scroll on mobile width" is a bug per the same atom.
 *     A vertical stack progressively enhances at the desktop
 *     breakpoint with extra metadata revealed inline.
 *   - The audit chain is read top-to-bottom (this atom -> what
 *     produced it -> what produced THAT) which maps cleanly to a
 *     reading order. A horizontal tree would require the operator
 *     to mentally invert direction.
 *   - Diamond shapes (two children -> same parent) are still
 *     legible: the parent appears once with two inbound edges drawn
 *     by the layout helper.
 *
 * App-grade interaction requirements (canon `dev-app-grade-interactions`):
 *   - Skeleton during pending; no flash-of-empty.
 *   - The toggle uses a CSS-driven chevron rotation; no layout shift.
 *   - prefers-reduced-motion strips the connector-pulse animation.
 *   - Clicks on a node use href + setRoute (pushState), never a full
 *     reload; modifier-key clicks fall through to the browser default
 *     so cmd-click opens in a new tab.
 */
export function AuditChainView({ atomId, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);

  const query = useQuery({
    queryKey: ['atoms.audit-chain', atomId],
    queryFn: ({ signal }) => getAuditChain(atomId, { signal }),
    /*
     * Atoms are immutable once written; the chain only changes when
     * a new descendant adds a derived_from pointer (which would not
     * appear in this view). 60s is the same staleness used by canon-
     * card sub-blocks.
     */
    staleTime: 60_000,
    enabled: open,
  });

  return (
    <section
      className={styles.panel}
      data-testid="audit-chain-panel"
      data-atom-id={atomId}
      data-open={open ? 'true' : 'false'}
    >
      <button
        type="button"
        className={`${styles.toggle} ${open ? styles.toggleOpen : ''}`}
        aria-expanded={open}
        aria-controls={`audit-chain-body-${atomId}`}
        onClick={() => setOpen((x) => !x)}
        data-testid="audit-chain-toggle"
      >
        <ChevronDown
          size={14}
          strokeWidth={2}
          className={styles.toggleChevron}
          aria-hidden="true"
        />
        <span className={styles.toggleIcon} aria-hidden="true">
          <GitBranch size={14} strokeWidth={1.75} />
        </span>
        <span>Audit chain</span>
        <span className={styles.toggleHint}>
          {open ? 'how this atom traces back' : 'derived_from ancestors'}
        </span>
      </button>

      {open && (
        <div
          id={`audit-chain-body-${atomId}`}
          className={styles.body}
          data-testid="audit-chain-body"
        >
          {query.isPending && (
            <div className={styles.skeleton} aria-hidden="true" data-testid="audit-chain-skeleton" />
          )}
          {query.isError && (
            <InlineError
              message={toErrorMessage(query.error)}
              testId="audit-chain-error"
            />
          )}
          {query.isSuccess && query.data === null && (
            <p className={styles.empty} data-testid="audit-chain-not-found">
              Atom <code>{atomId}</code> is not in the substrate.
            </p>
          )}
          {query.isSuccess && query.data && (
            /*
             * Seed identity comes from the response (atoms[0]) not the
             * URL atomId so the "this atom" badge anchors on what the
             * server actually returned. The two are identical in
             * production; tests that mock atoms.audit-chain with a
             * fixture seed id (different from the route id) still
             * highlight the right node.
             */
            <AuditChainBody
              result={query.data}
              seedId={query.data.atoms[0]?.id ?? atomId}
            />
          )}
        </div>
      )}
    </section>
  );
}

interface BodyProps {
  readonly result: AuditChainResult;
  readonly seedId: string;
}

function AuditChainBody({ result, seedId }: BodyProps) {
  const layout = useMemo<AuditChainLayout>(
    () => computeAuditChainLayout(result.atoms, result.edges, seedId),
    [result, seedId],
  );

  if (result.atoms.length === 1) {
    /*
     * Seed-only chain: the atom has no derived_from references.
     * Surface a one-line empty state inside the panel so the operator
     * sees that the lookup ran (vs an error swallowed). Saves a
     * full empty-state component render for the common case.
     */
    return (
      <p className={styles.empty} data-testid="audit-chain-empty">
        This atom has no upstream provenance. It is the start of its chain.
      </p>
    );
  }

  return (
    <>
      <ul
        className={styles.timeline}
        data-testid="audit-chain-timeline"
        data-node-count={layout.nodes.length}
        aria-label={`Audit chain for ${seedId}: ${layout.nodes.length} atoms, ${result.edges.length} edges`}
      >
        {layout.nodes.map((node, index) => (
          <Node
            key={node.atom.id}
            atom={node.atom}
            depth={node.depth}
            isSeed={node.atom.id === seedId}
            isLast={index === layout.nodes.length - 1}
            edgeFromAbove={node.atom.id !== seedId}
          />
        ))}
      </ul>
      {(result.truncated.depth_reached || result.truncated.missing_ancestors > 0) && (
        <p className={styles.truncationNote} data-testid="audit-chain-truncation-note">
          {result.truncated.depth_reached && (
            <span>Chain truncated at depth limit. </span>
          )}
          {result.truncated.missing_ancestors > 0 && (
            <span>
              {result.truncated.missing_ancestors} upstream
              {result.truncated.missing_ancestors === 1 ? ' atom is' : ' atoms are'} not shown.
            </span>
          )}
        </p>
      )}
    </>
  );
}

interface NodeProps {
  readonly atom: AnyAtom;
  readonly depth: number;
  readonly isSeed: boolean;
  readonly isLast: boolean;
  /**
   * True when a connector should be drawn from the previous node down
   * to this one. The seed (depth 0) does not have an incoming edge
   * because it is the bottom of the chain in the substrate but the
   * top of the timeline visually.
   */
  readonly edgeFromAbove: boolean;
}

function Node({ atom, depth, isSeed, isLast, edgeFromAbove }: NodeProps) {
  const target = routeForAtomId(atom.id);
  const tone = atomTypeTone(atom.type);
  const planState = atom.plan_state ?? atom.pipeline_state;

  return (
    <li
      className={styles.node}
      data-testid={`audit-chain-node-${atom.id}`}
      data-atom-id={atom.id}
      data-atom-type={atom.type}
      data-depth={depth}
      data-is-seed={isSeed ? 'true' : 'false'}
      data-is-last={isLast ? 'true' : 'false'}
    >
      <div className={styles.gutter} aria-hidden="true">
        {edgeFromAbove && <span className={styles.connectorTop} />}
        <span
          className={styles.dot}
          data-is-seed={isSeed ? 'true' : 'false'}
          style={{ color: tone }}
        />
        {!isLast && <span className={styles.connectorBottom} />}
      </div>
      <a
        className={styles.card}
        href={routeHref(target, atom.id)}
        data-is-seed={isSeed ? 'true' : 'false'}
        onClick={(e) => {
          if (e.defaultPrevented) return;
          if (e.button !== 0) return;
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          e.stopPropagation();
          setRoute(target, atom.id);
        }}
        title={`Open ${atom.id}`}
        data-testid={`audit-chain-card-${atom.id}`}
      >
        <div className={styles.cardHeader}>
          <span
            className={styles.typeChip}
            data-atom-type={atom.type}
            style={{ color: tone }}
          >
            {atom.type}
          </span>
          {isSeed && (
            <span className={styles.seedBadge} data-testid="audit-chain-seed-badge">
              <Sparkles size={11} strokeWidth={2.25} aria-hidden="true" />
              this atom
            </span>
          )}
          {planState && (
            <span className={styles.statePill} data-testid={`audit-chain-state-${atom.id}`}>
              {planState}
            </span>
          )}
        </div>
        <code className={styles.id}>{atom.id}</code>
        <div className={styles.meta}>
          <span className={styles.metaItem}>
            <span className={styles.metaLabel}>by</span>
            <code className={styles.metaCode}>{atom.principal_id}</code>
          </span>
          <span className={styles.metaDot} aria-hidden="true">{'\u00B7'}</span>
          <TimeAgo iso={atom.created_at} />
        </div>
      </a>
    </li>
  );
}
