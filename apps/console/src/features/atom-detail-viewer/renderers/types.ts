/**
 * Renderer-shape contract for the atom-detail dispatch table.
 *
 * Each renderer is a React component that receives the resolved atom
 * and renders the type-specific body block (one block; the surrounding
 * shell (header, provenance, supersedes, references, raw JSON) is
 * the AtomDetailView's responsibility, not the renderer's).
 *
 * Why a contract: keeps the dispatch table type-safe and the renderer
 * surface tight. Renderers do NOT fetch (the parent does), do NOT own
 * the page chrome (the parent does), do NOT mutate state (the page is
 * read-only per the console v1 contract). Every renderer is a pure
 * function of the atom.
 *
 * Per canon `dev-canon-strategic-not-tactical`, the type-name <->
 * renderer mapping is a tactical fact captured in `pickRenderer`'s
 * lookup table; it is not atomized as canon. Adding a new type-specific
 * renderer is a one-line dispatch-table edit.
 */

import type { ComponentType } from 'react';
import type { AnyAtom } from '@/services/atoms.service';

export interface AtomRendererProps {
  readonly atom: AnyAtom;
}

export type AtomRenderer = ComponentType<AtomRendererProps>;
