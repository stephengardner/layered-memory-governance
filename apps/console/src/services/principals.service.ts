import { transport } from './transport';

export interface Principal {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly active: boolean;
  readonly signed_by?: string | null;
  readonly compromised_at?: string | null;
  readonly created_at?: string;
  readonly permitted_scopes?: {
    readonly read?: ReadonlyArray<string>;
    readonly write?: ReadonlyArray<string>;
  };
  readonly permitted_layers?: {
    readonly read?: ReadonlyArray<string>;
    readonly write?: ReadonlyArray<string>;
  };
  readonly goals?: ReadonlyArray<string>;
  readonly constraints?: ReadonlyArray<string>;
}

export async function listPrincipals(signal?: AbortSignal): Promise<ReadonlyArray<Principal>> {
  return transport.call<ReadonlyArray<Principal>>(
    'principals.list',
    undefined,
    signal ? { signal } : undefined,
  );
}

/**
 * Nested principal tree as returned by /api/principals.tree. Mirrors
 * the server-side PrincipalTreeNode shape one-to-one so the renderer
 * can recurse without normalising.
 *
 * The kind discriminator is server-derived from depth + role: 'root'
 * for depth===0, then role-mapped for the rest. taint_state is a
 * three-state projection over compromised_at along the signed_by
 * chain ('compromised' if THIS principal, 'inherited' if any
 * ancestor, 'clean' otherwise). Renders as a badge so an operator
 * sees blast-radius at a glance without expanding nodes.
 */
export interface PrincipalTreeNode {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly depth: number;
  readonly kind: 'root' | 'agent' | 'human' | 'unknown';
  readonly taint_state: 'clean' | 'compromised' | 'inherited';
  readonly active: boolean;
  readonly children: ReadonlyArray<PrincipalTreeNode>;
}

export interface PrincipalTreeResponse {
  readonly roots: ReadonlyArray<PrincipalTreeNode>;
  /**
   * Principals whose signed_by points at an id that no longer exists
   * in the principal store. Surfaced so the UI can warn rather than
   * render them as ghost roots.
   */
  readonly orphans: ReadonlyArray<string>;
}

export async function getPrincipalsTree(signal?: AbortSignal): Promise<PrincipalTreeResponse> {
  return transport.call<PrincipalTreeResponse>(
    'principals.tree',
    undefined,
    signal ? { signal } : undefined,
  );
}
