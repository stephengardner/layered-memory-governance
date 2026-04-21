/**
 * File-backed PrincipalStore.
 *
 * Layout:
 *   rootDir/principals/<principal-id>.json
 *
 * Permission logic is identical to the memory adapter; the store just swaps
 * the persistence substrate.
 */

import { readdir } from 'node:fs/promises';
import { NotFoundError } from '../../substrate/errors.js';
import type { PrincipalStore } from '../../substrate/interface.js';
import type { Action, Principal, PrincipalId, Target, Time } from '../../substrate/types.js';
import { isEnoent, p, readJsonOrNull, writeJson } from './util.js';

export class FilePrincipalStore implements PrincipalStore {
  private readonly dir: string;

  constructor(rootDir: string) {
    this.dir = p(rootDir, 'principals');
  }

  async get(id: PrincipalId): Promise<Principal | null> {
    return readJsonOrNull<Principal>(this.pathFor(id));
  }

  async put(principal: Principal): Promise<PrincipalId> {
    await writeJson(this.pathFor(principal.id), principal);
    return principal.id;
  }

  async permits(principalId: PrincipalId, action: Action, target: Target): Promise<boolean> {
    const p = await this.get(principalId);
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
    const existing = await this.get(id);
    if (!existing) throw new NotFoundError(`Principal ${String(id)} not found`);
    const updated: Principal = {
      ...existing,
      compromised_at: atTime,
      active: false,
    };
    await writeJson(this.pathFor(id), updated);
  }

  async listActive(): Promise<ReadonlyArray<Principal>> {
    try {
      const entries = await readdir(this.dir);
      const out: Principal[] = [];
      for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        const principal = await readJsonOrNull<Principal>(p(this.dir, name));
        if (principal && principal.active && principal.compromised_at === null) {
          out.push(principal);
        }
      }
      return out;
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
  }

  private pathFor(id: PrincipalId): string {
    return p(this.dir, `${String(id)}.json`);
  }
}
