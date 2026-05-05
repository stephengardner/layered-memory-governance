import { useQuery } from '@tanstack/react-query';
import { Brain, Compass, GitBranch, ShieldQuestion } from 'lucide-react';
import { AtomRef } from '@/components/atom-ref/AtomRef';
import { existsAtoms, type AnyAtom } from '@/services/atoms.service';
import { routeForAtomId, routeHref, setRoute } from '@/state/router.store';
import { Section } from './Section';
import {
  extractDeliberation,
  hasAnyDeliberation,
} from './deliberation-fields';
import styles from './Deliberation.module.css';

/**
 * Deliberation surface.
 *
 * Renders the heuristic-thinking trail an atom carries (plan or
 * canon -- both shapes share the same metadata fields). Section
 * order matches the operator mental model:
 *
 *   1. Principles applied   -- "what canon was this grounded in"
 *                              (clickable, with missing-atom
 *                              treatment if the cited id does not
 *                              resolve to an existing atom in the store)
 *   2. Alternatives rejected -- "what other paths were considered
 *                              and why each was demoted"
 *   3. What breaks if revisited -- "the 3-month-later regret check",
 *                              rendered as a quoted callout
 *   4. Derived from         -- "the ancestor atoms in the
 *                              provenance chain"
 *
 * An atom that carries none of these renders nothing -- no empty
 * section, no "no deliberation captured" placeholder. The section is
 * a positive signal: when it appears, the operator knows reasoning
 * was logged. When it doesn't appear, the operator opens the raw
 * JSON or the deliberation-trail view if they need to dig.
 *
 * Scope:
 *   - Plans: `PlanRenderer` substitutes this component for its
 *     prior inline rendering.
 *   - Canon: `CanonCard` substitutes this component for its prior
 *     inline rendering.
 *   - Future surfaces (operator-intent detail, observation detail,
 *     pipeline-stage outputs) inherit the same shape by importing
 *     this module.
 */
export function Deliberation({ atom }: { atom: AnyAtom }) {
  const fields = extractDeliberation(atom);
  if (!hasAnyDeliberation(fields)) return null;
  return (
    <Section title="Deliberation" testId="atom-detail-deliberation">
      <div className={styles.deliberation}>
        <PrinciplesAppliedBlock principles={fields.principlesApplied} />
        <AlternativesRejectedBlock alternatives={fields.alternativesRejected} />
        <WhatBreaksBlock text={fields.whatBreaksIfRevisit} />
        <DerivedFromBlock derivedFrom={fields.derivedFrom} />
      </div>
    </Section>
  );
}

/*
 * Sub-section primitive. Co-located here (not in Section.tsx) because
 * it carries an icon + count + an optional empty hint, none of which
 * the universal `Section` consumer needs. Keeping it local also keeps
 * the surface consumer-facing API of `<Deliberation atom={...} />`
 * single-component and free of layout primitives leaking out.
 */
function SubSection({
  title,
  icon,
  count,
  testId,
  children,
}: {
  readonly title: string;
  readonly icon: React.ReactNode;
  readonly count?: number | undefined;
  readonly testId?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className={styles.subSection} {...(testId ? { 'data-testid': testId } : {})}>
      <header className={styles.subSectionHeader}>
        <span className={styles.subSectionHeaderIcon} aria-hidden="true">{icon}</span>
        <h4 className={styles.subSectionTitle}>{title}</h4>
        {typeof count === 'number' && count > 0 && (
          <span className={styles.subSectionCount}>{count}</span>
        )}
      </header>
      {children}
    </section>
  );
}

function PrinciplesAppliedBlock({ principles }: { principles: ReadonlyArray<string> }) {
  if (principles.length === 0) return null;
  /*
   * One batched atoms.exists query at the outer block; the resolver
   * checks all N principle ids in a single in-memory Map lookup pass
   * server-side. Avoids N x useQuery (which would render N hover
   * cards' worth of independent fetches when the operator opens a
   * plan citing 12 principles).
   *
   * The query key includes the sorted id list so two plans citing
   * different principle sets don't share a stale answer; sorted so
   * order-only differences hit the same cache.
   *
   * `enabled` defaults to true so a card with principles fetches
   * immediately on mount; CanonCard ALREADY renders the deliberation
   * lazily because the canon-card details panel only mounts when the
   * user expands the card.
   */
  const sortedIds = [...principles].sort();
  const query = useQuery({
    queryKey: ['atoms.exists', sortedIds],
    queryFn: ({ signal }) => existsAtoms(sortedIds, signal),
    staleTime: 60_000,
  });
  const exists = new Map<string, boolean>(
    (query.data ?? []).map((entry) => [entry.id, entry.exists]),
  );
  /*
   * While the resolver is in flight we DON'T paint principles as
   * missing -- a transient "looks broken" state during a refetch
   * teaches the operator the wrong thing. We surface the missing
   * affordance only after `query.isSuccess` (we have ground truth)
   * OR `query.isError` (the resolver itself failed; we already had
   * to choose a tone, and "no resolution" is closer to "trust the
   * citation as-is" than "everything is broken").
   *
   * On error: chips render as plain (NOT missing). The InlineError
   * affordance for the resolver itself is a future surface; today
   * the cost of marking N citations as broken when the resolver
   * blew up is higher than the cost of staying quiet about it.
   */
  const resolutionReady = query.isSuccess;
  return (
    <SubSection
      title="Principles applied"
      icon={<Brain size={12} strokeWidth={1.75} aria-hidden="true" />}
      count={principles.length}
      testId="atom-detail-deliberation-principles"
    >
      <ul className={styles.chipList}>
        {principles.map((id) => (
          <li key={id} className={styles.principleItem}>
            <PrincipleChip
              id={id}
              missing={resolutionReady && exists.get(id) === false}
            />
          </li>
        ))}
      </ul>
    </SubSection>
  );
}

/**
 * Single principle chip. When the cited id resolves to an atom in the
 * store (the common case) we render an `AtomRef`-style anchor that
 * routes via the standard `setRoute(routeForAtomId(id), id)` flow,
 * gaining the shared hover-card preview for free.
 *
 * When the id does NOT resolve, we render a strikethrough chip with
 * a `title` attribute (browser-native tooltip) explaining the gap.
 * The anchor still routes (so the operator can land on the empty
 * detail view and confirm) but the visual demotion makes the broken
 * citation impossible to miss. Per canon `dev-drafter-citation-verification-required`,
 * surfacing this asymmetry is exactly the kind of after-the-fact
 * read that catches drafter-confabulation drift the substrate-level
 * mitigation cannot fully prevent today.
 *
 * Note: "existing atom" here means "any atom in the store", not just
 * canon. The atoms.exists endpoint resolves against the entire
 * atomIndex (canon + plans + intents + observations + everything).
 * A plan citing an intent-* atom that exists is NOT marked missing;
 * a plan citing a fabricated id that exists nowhere is.
 */
function PrincipleChip({ id, missing }: { readonly id: string; readonly missing: boolean }) {
  if (missing) {
    const target = routeForAtomId(id);
    return (
      <a
        className={styles.principleChipMissing}
        href={routeHref(target, id)}
        title={`Missing atom: ${id} is cited as a principle but does not resolve to an existing atom in the store.`}
        data-testid="atom-detail-deliberation-principle"
        data-atom-id={id}
        data-missing="true"
        onClick={(e) => {
          if (e.defaultPrevented || e.button !== 0) return;
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          setRoute(target, id);
        }}
      >
        {id}
      </a>
    );
  }
  /*
   * AtomRef gives us the shared hover-preview, the routing wiring,
   * and the same visual language the rest of the app uses for
   * canon-id chips. Wrapping it in our `principleItem` div keeps the
   * `data-missing="false"` testing hook on a stable parent element.
   */
  return (
    <span
      className={styles.principleChip}
      data-testid="atom-detail-deliberation-principle"
      data-atom-id={id}
      data-missing="false"
    >
      <AtomRef id={id} />
    </span>
  );
}

function AlternativesRejectedBlock({
  alternatives,
}: {
  alternatives: ReadonlyArray<{ readonly option: string; readonly reason?: string }>;
}) {
  if (alternatives.length === 0) return null;
  return (
    <SubSection
      title="Alternatives rejected"
      icon={<Compass size={12} strokeWidth={1.75} aria-hidden="true" />}
      count={alternatives.length}
      testId="atom-detail-deliberation-alternatives"
    >
      <ul className={styles.optionList}>
        {alternatives.map((alt, i) => (
          <li
            key={`${alt.option}-${i}`}
            className={styles.optionItem}
            data-testid="atom-detail-deliberation-alternative"
          >
            <span className={styles.optionTitle}>{alt.option}</span>
            {alt.reason && <span className={styles.optionReason}>{alt.reason}</span>}
          </li>
        ))}
      </ul>
    </SubSection>
  );
}

function WhatBreaksBlock({ text }: { text: string | null }) {
  if (text === null) return null;
  return (
    <SubSection
      title="What breaks if revisited"
      icon={<ShieldQuestion size={12} strokeWidth={1.75} aria-hidden="true" />}
      testId="atom-detail-deliberation-what-breaks"
    >
      <blockquote className={styles.whatBreaksCallout} cite="">
        {text}
      </blockquote>
    </SubSection>
  );
}

function DerivedFromBlock({ derivedFrom }: { derivedFrom: ReadonlyArray<string> }) {
  if (derivedFrom.length === 0) return null;
  return (
    <SubSection
      title="Derived from"
      icon={<GitBranch size={12} strokeWidth={1.75} aria-hidden="true" />}
      count={derivedFrom.length}
      testId="atom-detail-deliberation-derived-from"
    >
      <ul className={styles.refList}>
        {derivedFrom.map((id) => (
          <li key={id} className={styles.refItem}>
            <AtomRef id={id} />
          </li>
        ))}
      </ul>
    </SubSection>
  );
}

/*
 * Test surface: re-export the narrowing module so unit tests have a
 * single import. The Deliberation component itself relies on browser
 * APIs (TanStack Query, history.pushState) so its rendering branch
 * is covered by Playwright in the e2e suite, not by vitest.
 */
export type { DeliberationFields } from './deliberation-fields';
