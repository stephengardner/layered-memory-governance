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

/*
 * Principal "soul" content: the markdown skill doc paired with this
 * principal at .claude/skills/<id>/SKILL.md, fetched via the API.
 *
 * The response carries TWO fields:
 *
 *   - `category`: a classifier outcome (always present) that names
 *     why the empty state is empty when content is null. Four cases
 *     today: 'authority-root' (apex authority, by design no playbook),
 *     'authority-anchor' (agent that signs others, by design no
 *     playbook), 'actor-with-skill' (skill exists; renders content),
 *     'actor-skill-debt' (leaf actor whose SKILL.md has not been
 *     authored yet, real debt). The classification is computed
 *     server-side because the inputs (signed_by graph, file presence)
 *     are not naturally available on the client.
 *
 *   - `content`: markdown body of SKILL.md, or null when no file
 *     exists. The empty-state branch reads category to decide which
 *     copy variant to render.
 *
 * The API surface (server/index.ts handlePrincipalSkill) holds the
 * canonical read; the console never reaches into .claude/ directly,
 * preserving the agent + UI single-source-of-truth contract.
 */
export type PrincipalCategory =
  | 'authority-root'
  | 'authority-anchor'
  | 'actor-with-skill'
  | 'actor-skill-debt';

export interface PrincipalSkill {
  readonly category: PrincipalCategory;
  readonly content: string | null;
}

export async function getPrincipalSkill(
  principalId: string,
  signal?: AbortSignal,
): Promise<PrincipalSkill> {
  return transport.call<PrincipalSkill>(
    'principals.skill',
    { principal_id: principalId },
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

/**
 * Per-principal atom counts. Surfaced on PrincipalCard as a chip row
 * showing top atom types (plans, observations, decisions). Wire shape
 * mirrors the server's PrincipalStatsResponse one-to-one.
 */
export interface PrincipalStats {
  readonly total: number;
  readonly by_type: Readonly<Record<string, number>>;
}

export interface PrincipalStatsResponse {
  readonly stats: Readonly<Record<string, PrincipalStats>>;
  readonly generated_at: string;
}

export async function getPrincipalsStats(signal?: AbortSignal): Promise<PrincipalStatsResponse> {
  return transport.call<PrincipalStatsResponse>(
    'principals.stats',
    undefined,
    signal ? { signal } : undefined,
  );
}
