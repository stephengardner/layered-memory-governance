import type { ReactNode } from 'react';

export interface PinnedPlansRowProps {
  pinnedIds: string[];
  renderCard: (id: string) => ReactNode;
}

export function PinnedPlansRow({ pinnedIds, renderCard }: PinnedPlansRowProps) {
  if (pinnedIds.length === 0) return null;
  return (
    <section
      aria-labelledby="pinned-plans-heading"
      data-testid="pinned-plans-row"
      style={{
        marginBottom: 16,
        paddingBottom: 16,
        borderBottom: '1px solid var(--lag-border, rgba(0,0,0,0.08))',
      }}
    >
      <h2
        id="pinned-plans-heading"
        style={{ fontSize: 14, fontWeight: 600, margin: '0 0 8px 0', opacity: 0.75 }}
      >
        Pinned
      </h2>
      <div
        data-testid="pinned-plans-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 12,
        }}
      >
        {pinnedIds.map((id) => (
          <div key={id} data-pinned-card-id={id}>
            {renderCard(id)}
          </div>
        ))}
      </div>
    </section>
  );
}
