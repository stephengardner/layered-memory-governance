import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ScrollText, GitBranch, ShieldCheck } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AtomRef } from '@/components/atom-ref/AtomRef';
import { ErrorState } from '@/components/state-display/StateDisplay';
import {
  getStageContext,
  type StageContext,
} from '@/services/stage-context.service';
import { toErrorMessage } from '@/services/errors';
import styles from './StageContextPanel.module.css';

type TabName = 'soul' | 'chain' | 'canon';

/**
 * Static tab order for arrow-key navigation. Mirrors the render
 * order of the three TabButton calls in StageContextBody so the
 * keyboard sequence matches the visual sequence (ArrowRight on soul
 * lands on chain, ArrowRight on canon wraps to soul). Listed at
 * module scope rather than recomputed on each render so identity is
 * stable for the keyDown handler.
 */
const TAB_ORDER: ReadonlyArray<TabName> = ['soul', 'chain', 'canon'];

interface Props {
  readonly atomId: string;
  /**
   * Override the open/closed state. The panel is collapsed by default
   * to avoid clutter on the plan-detail view; deliberation-trail can
   * pass `defaultOpen` to start expanded if it ever wants to.
   */
  readonly defaultOpen?: boolean;
}

/**
 * Stage Context: surfaces the operator-visible "soul" (vendored skill
 * markdown that supplied the agent prompt), upstream provenance
 * chain (earliest -> latest derived_from ancestors), and canon
 * directives that governed the stage at run-time.
 *
 * The panel is collapsed by default so the plan-detail view does not
 * grow by hundreds of lines of markdown on every visit. Once open, a
 * three-tab layout keeps each lens distinct -- soul, chain, canon --
 * because they answer different operator questions and stacking them
 * vertically would force scrolling for any of the three.
 *
 * Behavior notes:
 *   - Atoms that are not pipeline-stage outputs render an empty-state
 *     header (the endpoint returns a stable empty shape).
 *   - Soul = null is informative: the operator sees a small empty
 *     state explaining the bundle was not vendored, rather than a
 *     blank tab.
 *   - Markdown is rendered via react-markdown + remark-gfm so links
 *     and code blocks are sanitized through the library's default
 *     pipeline (no raw HTML pass-through). This matches the same
 *     renderer used by the principal-skill view.
 */
export function StageContextPanel({ atomId, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [tab, setTab] = useState<TabName>('soul');

  const query = useQuery({
    queryKey: ['atoms.stage-context', atomId],
    queryFn: ({ signal }) => getStageContext(atomId, signal),
    enabled: open,
    staleTime: 60_000,
  });

  return (
    <section
      className={styles.panel}
      data-testid="stage-context-panel"
      data-atom-id={atomId}
      data-open={open ? 'true' : 'false'}
    >
      <button
        type="button"
        className={`${styles.toggle} ${open ? styles.toggleOpen : ''}`}
        aria-expanded={open}
        aria-controls={`stage-context-body-${atomId}`}
        onClick={() => setOpen((x) => !x)}
        data-testid="stage-context-toggle"
      >
        <ChevronDown
          size={14}
          strokeWidth={2}
          className={styles.toggleChevron}
          aria-hidden="true"
        />
        <span>Stage context</span>
        <span className={styles.toggleHint}>
          {open ? 'how this stage was prompted' : 'soul + chain + canon'}
        </span>
      </button>

      {open && (
        <div
          id={`stage-context-body-${atomId}`}
          className={styles.body}
          data-testid="stage-context-body"
        >
          {query.isPending && (
            <div className={styles.skeleton} aria-hidden="true" />
          )}
          {query.isError && (
            <ErrorState
              title="Could not load stage context"
              message={toErrorMessage(query.error)}
              testId="stage-context-error"
            />
          )}
          {query.isSuccess && query.data === null && (
            <p className={styles.empty} data-testid="stage-context-not-found">
              Atom <code>{atomId}</code> is not in the substrate.
            </p>
          )}
          {query.isSuccess && query.data && (
            <StageContextBody
              context={query.data}
              tab={tab}
              onTabChange={setTab}
            />
          )}
        </div>
      )}
    </section>
  );
}

interface BodyProps {
  readonly context: StageContext;
  readonly tab: TabName;
  readonly onTabChange: (next: TabName) => void;
}

function StageContextBody({ context, tab, onTabChange }: BodyProps) {
  const tablistRef = useRef<HTMLDivElement | null>(null);

  if (context.stage === null) {
    return (
      <p className={styles.empty} data-testid="stage-context-empty">
        This atom was not produced by a deep planning pipeline stage.
      </p>
    );
  }

  /**
   * Roving-focus keyboard handler for the tablist. Implements the WAI-
   * ARIA Authoring Practices `Tabs` pattern: ArrowLeft/ArrowRight cycle
   * through the tab set with wrap-around, Home/End jump to the
   * boundaries. Without this, inactive TabButtons carry tabIndex={-1}
   * and are unreachable for keyboard-only operators -- a hard
   * accessibility blocker on a panel meant to surface deep planning
   * provenance to the very people who do post-merge audits.
   *
   * Focus management: after onTabChange fires, the next render flips
   * tabIndex on the new active button to 0; we move focus to that
   * button via a scoped querySelector against the tablist ref (rather
   * than a global getElementById) so two stage-context panels on the
   * same page (deliberation trail, plan detail) cannot cross-focus
   * each other through duplicate ids. The deterministic id pattern
   * (`stage-context-tab-${name}`) is the same one already emitted for
   * `aria-labelledby` on each tabpanel, so consumers see a single
   * stable contract.
   */
  function onTablistKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const idx = TAB_ORDER.indexOf(tab);
    if (idx === -1) return;
    let next: TabName | null = null;
    switch (event.key) {
      case 'ArrowRight':
        next = TAB_ORDER[(idx + 1) % TAB_ORDER.length] ?? null;
        break;
      case 'ArrowLeft':
        next = TAB_ORDER[(idx - 1 + TAB_ORDER.length) % TAB_ORDER.length] ?? null;
        break;
      case 'Home':
        next = TAB_ORDER[0] ?? null;
        break;
      case 'End':
        next = TAB_ORDER[TAB_ORDER.length - 1] ?? null;
        break;
      default:
        return;
    }
    if (next === null || next === tab) return;
    event.preventDefault();
    onTabChange(next);
    // Move focus to the freshly-active tab. Use the tablist root as
    // the scoping element so two stage-context panels on the same
    // page (deliberation trail, plan detail) cannot cross-focus.
    const root = tablistRef.current;
    if (root === null) return;
    const target = root.querySelector<HTMLButtonElement>(
      `#stage-context-tab-${next}`,
    );
    target?.focus();
  }

  return (
    <>
      <header className={styles.header}>
        <dl className={styles.metaGrid}>
          <dt className={styles.metaLabel}>Stage</dt>
          <dd className={styles.metaValue} data-testid="stage-context-stage">
            {context.stage}
          </dd>
          {context.principal_id && (
            <>
              <dt className={styles.metaLabel}>Principal</dt>
              <dd className={styles.metaValue} data-testid="stage-context-principal">
                <code>{context.principal_id}</code>
              </dd>
            </>
          )}
          {context.skill_bundle && (
            <>
              <dt className={styles.metaLabel}>Skill bundle</dt>
              <dd className={styles.metaValue} data-testid="stage-context-skill-bundle">
                <code>{context.skill_bundle}</code>
              </dd>
            </>
          )}
        </dl>
      </header>

      <div
        ref={tablistRef}
        className={styles.tablist}
        role="tablist"
        aria-label="Stage context"
        data-testid="stage-context-tablist"
        onKeyDown={onTablistKeyDown}
      >
        <TabButton
          name="soul"
          active={tab === 'soul'}
          onClick={() => onTabChange('soul')}
          icon={<ScrollText size={13} strokeWidth={1.75} aria-hidden="true" />}
          label="Soul"
        />
        <TabButton
          name="chain"
          active={tab === 'chain'}
          onClick={() => onTabChange('chain')}
          icon={<GitBranch size={13} strokeWidth={1.75} aria-hidden="true" />}
          label="Upstream chain"
          count={context.upstream_chain.length}
        />
        <TabButton
          name="canon"
          active={tab === 'canon'}
          onClick={() => onTabChange('canon')}
          icon={<ShieldCheck size={13} strokeWidth={1.75} aria-hidden="true" />}
          label="Canon at runtime"
          count={context.canon_at_runtime.length}
        />
      </div>

      {tab === 'soul' && (
        <div
          role="tabpanel"
          aria-labelledby="stage-context-tab-soul"
          className={styles.tabpanel}
          data-testid="stage-context-soul"
        >
          <SoulTab soul={context.soul} skillBundle={context.skill_bundle} />
        </div>
      )}
      {tab === 'chain' && (
        <div
          role="tabpanel"
          aria-labelledby="stage-context-tab-chain"
          className={styles.tabpanel}
          data-testid="stage-context-chain"
        >
          <ChainTab chain={context.upstream_chain} />
        </div>
      )}
      {tab === 'canon' && (
        <div
          role="tabpanel"
          aria-labelledby="stage-context-tab-canon"
          className={styles.tabpanel}
          data-testid="stage-context-canon"
        >
          <CanonTab entries={context.canon_at_runtime} />
        </div>
      )}
    </>
  );
}

function TabButton({
  name,
  active,
  onClick,
  icon,
  label,
  count,
}: {
  readonly name: TabName;
  readonly active: boolean;
  readonly onClick: () => void;
  readonly icon: ReactNode;
  readonly label: string;
  readonly count?: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={`stage-context-tab-${name}`}
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className={`${styles.tab} ${active ? styles.tabActive : ''}`}
      onClick={onClick}
      data-testid={`stage-context-tab-${name}`}
    >
      <span className={styles.tabIcon}>{icon}</span>
      <span>{label}</span>
      {typeof count === 'number' && (
        <span className={styles.tabCount}>{count}</span>
      )}
    </button>
  );
}

function SoulTab({
  soul,
  skillBundle,
}: {
  readonly soul: string | null;
  readonly skillBundle: string | null;
}) {
  if (soul === null) {
    return (
      <p className={styles.empty}>
        No vendored bundle found for{' '}
        {skillBundle ? <code>{skillBundle}</code> : 'this stage'}. The agent ran
        with the operator's plugin-cache copy or a substrate-side default; the
        Console reads the vendored fallback under{' '}
        <code>examples/planning-stages/skills/</code> when the plugin cache is
        unavailable.
      </p>
    );
  }
  return (
    <div className={styles.markdown}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{soul}</ReactMarkdown>
    </div>
  );
}

function ChainTab({
  chain,
}: {
  readonly chain: ReadonlyArray<StageContext['upstream_chain'][number]>;
}) {
  if (chain.length === 0) {
    return (
      <p className={styles.empty}>
        No upstream provenance recorded. The atom's <code>derived_from</code>{' '}
        chain is empty (the seed atom of its own pipeline run).
      </p>
    );
  }
  return (
    <ol className={styles.chainList}>
      {chain.map((entry) => (
        <li
          key={entry.id}
          className={styles.chainItem}
          data-testid="stage-context-chain-entry"
          data-atom-id={entry.id}
          data-atom-type={entry.type}
        >
          <div className={styles.chainHeader}>
            <span className={styles.chainTypeChip}>{entry.type}</span>
            <AtomRef id={entry.id} variant="inline" />
          </div>
          {entry.content_preview && (
            <p className={styles.chainPreview}>{entry.content_preview}</p>
          )}
        </li>
      ))}
    </ol>
  );
}

function CanonTab({
  entries,
}: {
  readonly entries: ReadonlyArray<StageContext['canon_at_runtime'][number]>;
}) {
  if (entries.length === 0) {
    return (
      <p className={styles.empty}>
        No canon directives resolved for this stage at run-time. The substrate
        records <code>metadata.canon_directives_applied</code> when the stage
        runner stamps applied directives onto the atom; absent that, no
        per-principal policy atom matched.
      </p>
    );
  }
  return (
    <ul className={styles.canonList}>
      {entries.map((entry) => (
        <li
          key={entry.id}
          className={styles.canonItem}
          data-testid="stage-context-canon-entry"
          data-atom-id={entry.id}
          data-source={entry.source}
        >
          <div className={styles.canonHeader}>
            <AtomRef id={entry.id} variant="inline" />
            <span className={styles.canonSource} title={`source: ${entry.source}`}>
              {entry.source}
            </span>
          </div>
          {entry.content_preview && (
            <p className={styles.canonPreview}>{entry.content_preview}</p>
          )}
        </li>
      ))}
    </ul>
  );
}
