import { useQuery } from '@tanstack/react-query';
import { ShieldCheck, ShieldAlert, ShieldX, Shield } from 'lucide-react';
import { getKillSwitchState, type KillSwitchTier } from '@/services/kill-switch.service';
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
 * Header pill: current kill-switch tier + autonomy dial. Always
 * visible so the operator sees whether autonomy is active or a
 * kill-tier is engaged. Tiered colors: green off / amber soft /
 * orange medium / red hard.
 *
 * The autonomy dial renders as a tiny horizontal bar underneath the
 * label (0 = locked down, 1 = fully autonomous). Tooltip carries
 * the reason string if a tier is engaged.
 */
export function KillSwitchPill() {
  const query = useQuery({
    queryKey: ['kill-switch.state'],
    queryFn: ({ signal }) => getKillSwitchState(signal),
    refetchInterval: 20_000,
  });

  const state = query.data;
  if (!state) return null;
  const Icon = TIER_ICON[state.tier];
  const dialPct = Math.round(Math.max(0, Math.min(1, state.autonomyDial)) * 100);
  const title = [
    `kill-switch: ${state.tier}`,
    `autonomy ${dialPct}%`,
    state.since ? `since ${new Date(state.since).toLocaleString()}` : null,
    state.reason ? `reason: ${state.reason}` : null,
  ].filter(Boolean).join('\n');

  return (
    <span
      className={styles.pill}
      data-tier={state.tier}
      title={title}
      data-testid="kill-switch-pill"
    >
      <Icon size={12} strokeWidth={2.25} />
      <span className={styles.label}>{TIER_LABEL[state.tier]}</span>
      <span className={styles.dial} aria-hidden="true">
        <span className={styles.dialFill} style={{ width: `${dialPct}%` }} />
      </span>
    </span>
  );
}
