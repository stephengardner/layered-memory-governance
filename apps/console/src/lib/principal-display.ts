// Principal display label helper.
//
// Maps a small allowlist of principal ids to a friendlier display label at
// render time. The atom store keeps every principal_id verbatim (provenance
// + signed_by + arbitration all depend on byte-stability); only the console
// render layer applies these labels.
//
// Scope: display-layer only. Atom writes, canon, backend API responses,
// signed_by walks, and provenance chains all use the verbatim id. Callers
// that need the raw id (debug hover, copy-as-id, exports) continue to read
// `atom.principal_id` directly.
//
// Adding more rewrites: extend `PRINCIPAL_LABELS`. Keep the override map
// narrow; broad rewrites would obscure actor identity in legitimate audit
// scenarios.

export interface PrincipalDisplay {
  /** Human-readable label to render in UI. */
  readonly label: string;
  /** Optional role badge token (e.g., 'apex'); empty string when not in the override map. */
  readonly role: string;
  /** True when the principal_id was rewritten; callers can render a tooltip with the raw id. */
  readonly masked: boolean;
  /** The original id, always preserved so debug surfaces can show it. */
  readonly id: string;
}

const PRINCIPAL_LABELS: Readonly<Record<string, { label: string; role: string }>> = Object.freeze({
  // Apex-class principal slot: both the bootstrap id and the canonical
  // `operator-principal` slot render with the same role label.
  'stephen-human': { label: 'Apex Agent', role: 'apex' },
  'operator-principal': { label: 'Apex Agent', role: 'apex' },
});

const EMPTY_LABEL = '—';

export function describePrincipal(id: string | null | undefined): PrincipalDisplay {
  if (typeof id !== 'string' || id.length === 0) {
    return { label: EMPTY_LABEL, role: '', masked: false, id: '' };
  }
  const override = PRINCIPAL_LABELS[id];
  if (override) {
    return { label: override.label, role: override.role, masked: true, id };
  }
  return { label: id, role: '', masked: false, id };
}

// Convenience: for places that just want the label string (the most common
// render path). Equivalent to `describePrincipal(id).label`.
export function principalLabel(id: string | null | undefined): string {
  return describePrincipal(id).label;
}
