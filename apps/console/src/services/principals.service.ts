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
