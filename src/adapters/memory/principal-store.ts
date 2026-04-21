import { NotFoundError } from '../../substrate/errors.js';
import type { PrincipalStore } from '../../substrate/interface.js';
import type { Action, Principal, PrincipalId, Target, Time } from '../../substrate/types.js';
import type { MemoryClock } from './clock.js';

/**
 * In-memory principal store.
 *
 * `permits` implements a simple permission model:
 *   - compromised principals always denied
 *   - inactive principals denied
 *   - write/promote/commit_canon require the requested layer and scope
 *     to be in the principal's permitted set
 *   - mark_compromised requires role === "admin"
 *   - read requires the scope to be in permitted_scopes.read (or not set)
 */
export class MemoryPrincipalStore implements PrincipalStore {
  private readonly principals = new Map<PrincipalId, Principal>();

  constructor(private readonly _clock: MemoryClock) {}

  async get(id: PrincipalId): Promise<Principal | null> {
    return this.principals.get(id) ?? null;
  }

  async put(p: Principal): Promise<PrincipalId> {
    this.principals.set(p.id, p);
    return p.id;
  }

  async permits(principalId: PrincipalId, action: Action, target: Target): Promise<boolean> {
    const p = this.principals.get(principalId);
    if (!p) return false;
    if (!p.active) return false;
    if (p.compromised_at !== null) return false;

    switch (action) {
      case 'read':
        if (target.scope && !p.permitted_scopes.read.includes(target.scope)) return false;
        if (target.layer && !p.permitted_layers.read.includes(target.layer)) return false;
        return true;

      case 'write':
        if (target.scope && !p.permitted_scopes.write.includes(target.scope)) return false;
        if (target.layer && !p.permitted_layers.write.includes(target.layer)) return false;
        return true;

      case 'promote': {
        const layer = target.layer ?? 'L2';
        if (layer !== 'L2' && layer !== 'L3') return false;
        return p.permitted_layers.write.includes(layer);
      }

      case 'commit_canon':
        return p.permitted_layers.write.includes('L3');

      case 'mark_compromised':
        return p.role === 'admin';

      default: {
        const _exhaustive: never = action;
        void _exhaustive;
        return false;
      }
    }
  }

  async markCompromised(id: PrincipalId, atTime: Time, _reason: string): Promise<void> {
    const p = this.principals.get(id);
    if (!p) {
      throw new NotFoundError(`Principal ${String(id)} not found`);
    }
    const updated: Principal = {
      ...p,
      compromised_at: atTime,
      active: false,
    };
    this.principals.set(id, updated);
  }

  async listActive(): Promise<ReadonlyArray<Principal>> {
    const out: Principal[] = [];
    for (const p of this.principals.values()) {
      if (p.active && p.compromised_at === null) {
        out.push(p);
      }
    }
    return out;
  }

  // ---- Test helpers ----

  size(): number {
    return this.principals.size;
  }
}
