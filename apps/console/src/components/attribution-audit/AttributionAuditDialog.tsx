import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck, ShieldAlert, AlertOctagon, CheckCircle2, X, GitBranch } from 'lucide-react';
import { listPrincipals, type Principal } from '@/services/principals.service';
import { listAtomChain, type CanonAtom } from '@/services/canon.service';
import { AtomRef } from '@/components/atom-ref/AtomRef';
import { TimeAgo } from '@/components/time-ago/TimeAgo';
import styles from './AttributionAuditDialog.module.css';

interface Props {
  readonly atom: CanonAtom | null;
  readonly onClose: () => void;
}

/**
 * Attribution audit — the one governance-native feature a dashboard
 * has that a generic viewer doesn't (per the audit agent's item #5).
 *
 * Given an atom, walk:
 *   - the PRINCIPAL chain: atom.principal_id → signed_by → ... → root.
 *     Flag any compromised principal, any inactive principal, any
 *     chain break (signed_by points to a non-existent id).
 *   - the ATOM provenance chain: atom.derived_from transitively.
 *     Flag any tainted ancestor or any superseded ancestor.
 *
 * The answer a reviewer actually needs: "can I trust this atom's
 * authority right now?" A single break anywhere makes the answer no.
 */
export function AttributionAuditDialog({ atom, onClose }: Props) {
  useEffect(() => {
    if (!atom) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [atom, onClose]);

  const principalsQ = useQuery({
    queryKey: ['principals'],
    queryFn: ({ signal }) => listPrincipals(signal),
    enabled: !!atom,
  });

  const chainQ = useQuery({
    queryKey: ['atoms.chain', atom?.id ?? ''],
    queryFn: ({ signal }) => listAtomChain(atom!.id, 6, signal),
    enabled: !!atom,
    staleTime: 30_000,
  });

  return (
    <AnimatePresence>
      {atom && (
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
              aria-labelledby="attribution-title"
              data-testid="attribution-dialog"
            >
              <header className={styles.head}>
                <h2 id="attribution-title" className={styles.title}>
                  <ShieldCheck size={16} strokeWidth={2} />
                  Attribution audit
                </h2>
                <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
                  <X size={16} strokeWidth={2} />
                </button>
              </header>

              <div className={styles.target}>
                <AtomRef id={atom.id} />
                <span className={styles.targetMeta}>
                  authored <TimeAgo iso={atom.created_at} /> by <code>{atom.principal_id}</code>
                </span>
              </div>

              <PrincipalChainSection
                atom={atom}
                principals={principalsQ.data ?? []}
                loading={principalsQ.isPending}
              />

              <ProvenanceChainSection
                atom={atom}
                chain={chainQ.data ?? []}
                loading={chainQ.isPending}
              />

              <OverallVerdict
                atom={atom}
                principals={principalsQ.data ?? []}
                chain={chainQ.data ?? []}
              />
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}

interface ChainNode {
  principal: Principal | null;
  missingId?: string;
  compromised: boolean;
  inactive: boolean;
}

function walkPrincipalChain(atom: CanonAtom, principals: ReadonlyArray<Principal>): ChainNode[] {
  const byId = new Map(principals.map((p) => [p.id, p]));
  const out: ChainNode[] = [];
  let curId: string | null | undefined = atom.principal_id;
  const seen = new Set<string>();
  while (curId && !seen.has(curId) && out.length < 10) {
    seen.add(curId);
    const p = byId.get(curId);
    if (!p) {
      out.push({ principal: null, missingId: curId, compromised: false, inactive: false });
      break;
    }
    out.push({
      principal: p,
      compromised: Boolean(p.compromised_at),
      inactive: p.active === false,
    });
    curId = p.signed_by ?? null;
  }
  return out;
}

function PrincipalChainSection({
  atom,
  principals,
  loading,
}: {
  atom: CanonAtom;
  principals: ReadonlyArray<Principal>;
  loading: boolean;
}) {
  if (loading) {
    return <Section title="Principal chain"><p className={styles.muted}>Resolving principals…</p></Section>;
  }
  const chain = walkPrincipalChain(atom, principals);
  return (
    <Section title="Principal chain">
      <ol className={styles.chain}>
        {chain.map((node, i) => {
          if (!node.principal) {
            return (
              <li key={i} className={styles.chainItem} data-severity="break">
                <AlertOctagon size={14} strokeWidth={2} />
                <div>
                  <div className={styles.chainTitle}>chain break</div>
                  <div className={styles.chainSub}>signed_by points to <code>{node.missingId}</code> which is not in the principals directory</div>
                </div>
              </li>
            );
          }
          const severity = node.compromised ? 'compromised' : node.inactive ? 'inactive' : 'ok';
          return (
            <li key={node.principal.id} className={styles.chainItem} data-severity={severity}>
              {severity === 'ok' && <CheckCircle2 size={14} strokeWidth={2} />}
              {severity === 'inactive' && <ShieldAlert size={14} strokeWidth={2} />}
              {severity === 'compromised' && <AlertOctagon size={14} strokeWidth={2} />}
              <div>
                <div className={styles.chainTitle}>
                  {node.principal.name ?? node.principal.id}
                  {i === 0 && <span className={styles.tag}>author</span>}
                  {!node.principal.signed_by && <span className={styles.tag}>root</span>}
                </div>
                <div className={styles.chainSub}>
                  <code>{node.principal.id}</code>
                  {node.principal.role && <> · {node.principal.role}</>}
                  {node.compromised && (
                    <> · <span className={styles.danger}>COMPROMISED {node.principal.compromised_at && <TimeAgo iso={node.principal.compromised_at} />}</span></>
                  )}
                  {node.inactive && !node.compromised && <> · <span className={styles.warning}>inactive</span></>}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}

function ProvenanceChainSection({
  atom,
  chain,
  loading,
}: {
  atom: CanonAtom;
  chain: ReadonlyArray<CanonAtom>;
  loading: boolean;
}) {
  if (loading) {
    return <Section title="Provenance chain"><p className={styles.muted}>Walking derived_from…</p></Section>;
  }
  if (chain.length === 0) {
    return (
      <Section title="Provenance chain">
        <p className={styles.muted}>
          Atom has no ancestors. Provenance kind:{' '}
          <code>{(atom.provenance?.kind as string) ?? 'unknown'}</code>
        </p>
      </Section>
    );
  }
  return (
    <Section title={`Provenance chain (${chain.length} ancestor${chain.length === 1 ? '' : 's'})`}>
      <ol className={styles.chain}>
        {chain.map((a) => {
          const tainted = Boolean(a.taint) && a.taint !== 'clean';
          const superseded = (a.superseded_by?.length ?? 0) > 0;
          const severity = tainted ? 'compromised' : superseded ? 'inactive' : 'ok';
          return (
            <li key={a.id} className={styles.chainItem} data-severity={severity}>
              {severity === 'ok' && <CheckCircle2 size={14} strokeWidth={2} />}
              {severity === 'inactive' && <ShieldAlert size={14} strokeWidth={2} />}
              {severity === 'compromised' && <AlertOctagon size={14} strokeWidth={2} />}
              <div>
                <div className={styles.chainTitle}>
                  <AtomRef id={a.id} variant="inline" />
                  <span className={styles.tag}>{a.type}</span>
                  {tainted && <span className={`${styles.tag} ${styles.tagDanger}`}>tainted</span>}
                  {superseded && <span className={`${styles.tag} ${styles.tagWarn}`}>superseded</span>}
                </div>
                <div className={styles.chainSub}>
                  by <code>{a.principal_id}</code> · conf {a.confidence.toFixed(2)} · <TimeAgo iso={a.created_at} />
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}

function OverallVerdict({
  atom,
  principals,
  chain,
}: {
  atom: CanonAtom;
  principals: ReadonlyArray<Principal>;
  chain: ReadonlyArray<CanonAtom>;
}) {
  const principalChain = walkPrincipalChain(atom, principals);
  const breaks: string[] = [];
  for (const node of principalChain) {
    if (!node.principal && node.missingId) breaks.push(`principal ${node.missingId} missing`);
    if (node.principal && node.compromised) breaks.push(`${node.principal.id} compromised`);
  }
  for (const a of chain) {
    if (a.taint && a.taint !== 'clean') breaks.push(`ancestor ${a.id} tainted`);
  }
  const atomTainted = Boolean(atom.taint) && atom.taint !== 'clean';
  const atomSuperseded = (atom.superseded_by?.length ?? 0) > 0;
  if (atomTainted) breaks.push(`atom is tainted (${atom.taint})`);
  if (atomSuperseded) breaks.push(`atom is superseded`);

  if (breaks.length === 0) {
    return (
      <div className={styles.verdict} data-variant="ok">
        <CheckCircle2 size={18} strokeWidth={2} />
        <div>
          <div className={styles.verdictTitle}>Chain intact</div>
          <div className={styles.verdictDetail}>
            Principal chain resolves cleanly, no compromised ancestors, no tainted or superseded provenance.
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.verdict} data-variant="break">
      <GitBranch size={18} strokeWidth={2} />
      <div>
        <div className={styles.verdictTitle}>{breaks.length} break{breaks.length === 1 ? '' : 's'} detected</div>
        <ul className={styles.verdictList}>
          {breaks.map((b, i) => <li key={i}>{b}</li>)}
        </ul>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      {children}
    </section>
  );
}
