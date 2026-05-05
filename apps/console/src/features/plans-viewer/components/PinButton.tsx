import type { CSSProperties } from 'react';
import { usePinnedPlans } from '../hooks/usePinnedPlans';

export interface PinButtonProps {
  planAtomId: string;
  planTitle: string;
  style?: CSSProperties;
}

const baseStyle: CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  width: 36,
  height: 36,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: 'none',
  borderRadius: 18,
  background: 'transparent',
  cursor: 'pointer',
  padding: 0,
};

export function PinButton({ planAtomId, planTitle, style }: PinButtonProps) {
  const { isPinned, toggle } = usePinnedPlans();
  const pinned = isPinned(planAtomId);
  const label = pinned ? `Unpin plan ${planTitle}` : `Pin plan ${planTitle}`;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pinned}
      onClick={() => toggle(planAtomId)}
      data-pinned={pinned ? 'true' : 'false'}
      style={{ ...baseStyle, ...style }}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill={pinned ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.8"
        aria-hidden="true"
      >
        <path d="M12 2v7l4 4v3H8v-3l4-4V2z" />
        <line x1="12" y1="16" x2="12" y2="22" />
      </svg>
    </button>
  );
}
