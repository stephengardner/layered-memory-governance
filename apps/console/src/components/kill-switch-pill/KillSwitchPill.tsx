import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { ShieldCheck, ShieldAlert, ShieldX, Shield, Power, Pause } from 'lucide-react';
import { getKillSwitchState, transitionKillSwitch, type KillSwitchTier } from '@/services/kill-switch.service';
import { requireActorId } from '@/services/session.service';
import { useCurrentActorId } from '@/hooks/useCurrentActorId';
import styles from './KillSwitchPill.module.css';

const TIER_ICON: Record<KillSwitchTier, typeof Shield> = {
  off: ShieldCheck,
  soft: Shield,
  medium: ShieldAlert,
  hard: ShieldX,
};

const TIER_LABEL: Record<KillSwitchTier, string> = {
  off: 'auto',
  soft: 'soft',
  medium: 'medium',
  hard: 'hard',
};

/**
 * Header pill: current kill-switch tier + autonomy dial. Now also
 * a transition trigger — click opens a small popover where the
 * operator can flip between off ↔ soft. Medium and hard transitions
 * remain CLI-gated per `dec-kill-switch-design-first`; the popover
 * surfaces that as read-only explainer text, not a button.
 */
export function KillSwitchPill() {
  const [menuOpen, setMenuOpen] = useState(false);
  const pillRef = useRef<HTMLSpanElement>(null);
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['kill-switch.state'],
    queryFn: ({ signal }) => getKillSwitchState(signal),
    refetchInterval: 20_000,
  });

  /*
   * Kill-switch transitions are attributed to the server-resolved
   * operator identity, not a hardcoded id. If LAG_CONSOLE_ACTOR_ID
   * isn't set, the mutation throws at click time — a kill-switch
   * write with no known operator is a governance-integrity red flag,
   * so we fail loudly instead of silently attributing to a sentinel.
   */
  const actorId = useCurrentActorId();
  const mutation = useMutation({
    mutationFn: (to: 'off' | 'soft') =>
      transitionKillSwitch({ to, actor_id: requireActorId(actorId), reason: `UI transition to ${to}` }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kill-switch.state'] });
      setMenuOpen(false);
    },
  });

  // Close on Escape + outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    const onClick = (e: MouseEvent) => {
      if (!pillRef.current) return;
      if (!pillRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [menuOpen]);

  const state = query.data;
  if (!state) {
    return (
      <span className={styles.pill} data-tone="loading" data-testid="kill-switch-pill">
        <span className={styles.dot} />
        <span className={styles.label}>—</span>
      </span>
    );
  }

  const Icon = TIER_ICON[state.tier];
  const dialPct = Math.round(Math.max(0, Math.min(1, state.autonomyDial)) * 100);
  const aboveSoft = state.tier === 'medium' || state.tier === 'hard';

  return (
    <span className={styles.wrap} ref={pillRef}>
      <button
        type="button"
        className={styles.pill}
        data-tier={state.tier}
        onClick={() => setMenuOpen((x) => !x)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-testid="kill-switch-pill"
        title={[
          `kill-switch: ${state.tier}`,
          `autonomy ${dialPct}%`,
          state.since ? `since ${new Date(state.since).toLocaleString()}` : null,
          state.reason ? `reason: ${state.reason}` : null,
          'click to transition',
        ].filter(Boolean).join('\n')}
      >
        <Icon size={12} strokeWidth={2.25} />
        <span className={styles.label}>{TIER_LABEL[state.tier]}</span>
        <span className={styles.dial} aria-hidden="true">
          <span className={styles.dialFill} style={{ width: `${dialPct}%` }} />
        </span>
      </button>
      <AnimatePresence>
        {menuOpen && (
          <motion.div
            className={styles.menu}
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.14, ease: [0.2, 0, 0, 1] }}
            role="menu"
            data-testid="kill-switch-menu"
          >
            <header className={styles.menuHead}>
              <span className={styles.menuTitle}>kill-switch tier</span>
              <span className={styles.menuSubtitle}>
                current: <strong>{state.tier}</strong> · autonomy {dialPct}%
              </span>
            </header>
            {aboveSoft ? (
              <div className={styles.locked} data-testid="kill-switch-locked">
                <ShieldAlert size={16} strokeWidth={2} />
                <div>
                  <div className={styles.lockedTitle}>Above soft — CLI-gated</div>
                  <div className={styles.lockedDetail}>
                    Tier is <strong>{state.tier}</strong>. Medium and hard transitions
                    require the CLI path per <code>dec-kill-switch-design-first</code>.
                    The UI cannot lower out of medium/hard.
                  </div>
                </div>
              </div>
            ) : (
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.actionBtn}
                  data-tone="off"
                  disabled={state.tier === 'off' || mutation.isPending}
                  onClick={() => mutation.mutate('off')}
                  data-testid="kill-switch-to-off"
                >
                  <Power size={14} strokeWidth={2} />
                  <span>
                    <span className={styles.actionTitle}>auto (off)</span>
                    <span className={styles.actionDetail}>autonomy dial → 1.0</span>
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.actionBtn}
                  data-tone="soft"
                  disabled={state.tier === 'soft' || mutation.isPending}
                  onClick={() => mutation.mutate('soft')}
                  data-testid="kill-switch-to-soft"
                >
                  <Pause size={14} strokeWidth={2} />
                  <span>
                    <span className={styles.actionTitle}>soft stop</span>
                    <span className={styles.actionDetail}>autonomy dial → 0.5 · writes gated</span>
                  </span>
                </button>
              </div>
            )}
            <footer className={styles.menuFoot}>
              medium and hard transitions require CLI
            </footer>
            {mutation.isError && (
              <div className={styles.error}>{(mutation.error as Error).message}</div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </span>
  );
}
