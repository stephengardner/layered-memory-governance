/**
 * Persistent store for Actor App credentials.
 *
 * Layout under .lag/apps/:
 *
 *   .lag/apps/
 *   ├── <role>.json         { appId, slug, owner, installationId?, createdAt }
 *   └── keys/
 *       └── <role>.pem      private key bytes (chmod 0600 on unix)
 *
 * The JSON records are intentionally small and readable so an operator
 * can inspect them. The PEM files live alongside but hold the signing
 * secret; .gitignore excludes both paths.
 */

import { mkdir, readFile, writeFile, chmod, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Role names become filesystem paths; reject anything that could
 * escape the state dir. Mirrors the regex on RoleDefinition.name in
 * schema.ts but enforced HERE defensively because credentials-store
 * is an exported entry point callers can hit directly.
 */
const SAFE_ROLE_NAME = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
function assertSafeRole(role: string): void {
  if (typeof role !== 'string' || !SAFE_ROLE_NAME.test(role)) {
    throw new Error(`unsafe role name: ${JSON.stringify(role)} (must match ${SAFE_ROLE_NAME})`);
  }
}

export interface AppCredentialsRecord {
  readonly role: string;
  /** GitHub App numeric id. */
  readonly appId: number;
  /** GitHub App slug (URL-safe id, e.g. `lag-cto-agent`). */
  readonly slug: string;
  /** The operator/org this App lives under on GitHub. */
  readonly owner: string;
  /** Installation id once the App has been installed on at least one target. */
  readonly installationId?: number;
  /** ISO timestamp the credentials were written. */
  readonly createdAt: string;
  /** Short description captured from the schema at provision time. */
  readonly description: string;
}

export interface CredentialsStore {
  readonly stateDir: string;
  readonly appsDir: string;
  readonly keysDir: string;
  exists(role: string): boolean;
  load(role: string): Promise<{ record: AppCredentialsRecord; privateKey: string } | null>;
  save(record: AppCredentialsRecord, privateKey: string): Promise<void>;
  update(record: AppCredentialsRecord): Promise<void>;
  list(): Promise<ReadonlyArray<AppCredentialsRecord>>;
}

export function createCredentialsStore(stateDir: string): CredentialsStore {
  const appsDir = join(stateDir, 'apps');
  const keysDir = join(appsDir, 'keys');

  const recordPath = (role: string) => { assertSafeRole(role); return join(appsDir, `${role}.json`); };
  const keyPath = (role: string) => { assertSafeRole(role); return join(keysDir, `${role}.pem`); };

  return {
    stateDir,
    appsDir,
    keysDir,

    exists(role) {
      return existsSync(recordPath(role));
    },

    async load(role) {
      const rp = recordPath(role);
      if (!existsSync(rp)) return null;
      const [json, pem] = await Promise.all([
        readFile(rp, 'utf8'),
        readFile(keyPath(role), 'utf8'),
      ]);
      const record = JSON.parse(json) as AppCredentialsRecord;
      return { record, privateKey: pem };
    },

    async save(record, privateKey) {
      assertSafeRole(record.role);
      await mkdir(keysDir, { recursive: true });
      const rp = recordPath(record.role);
      const kp = keyPath(record.role);
      // Order is load-bearing: write the secret first, then the
      // discoverable metadata. If the PEM write fails, `exists()`
      // returns false so sync re-tries; if we wrote the record
      // first and the PEM second, a crash between would leave a
      // "provisioned" marker with no private key and sync would
      // silently skip re-provisioning forever.
      await writeFile(kp, privateKey, { encoding: 'utf8', mode: 0o600 });
      try { await chmod(kp, 0o600); } catch { /* windows may reject */ }
      try {
        await writeFile(rp, JSON.stringify(record, null, 2) + '\n', 'utf8');
      } catch (err) {
        // Record write failed after the key landed. Remove the
        // orphaned key so the next sync starts clean.
        try { await rm(kp, { force: true }); } catch { /* best effort */ }
        throw err;
      }
    },

    async update(record) {
      assertSafeRole(record.role);
      const rp = recordPath(record.role);
      if (!existsSync(rp)) throw new Error(`no credentials for role: ${record.role}`);
      await writeFile(rp, JSON.stringify(record, null, 2) + '\n', 'utf8');
    },

    async list() {
      if (!existsSync(appsDir)) return [];
      const entries = await readdir(appsDir);
      const records: AppCredentialsRecord[] = [];
      for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        const json = await readFile(join(appsDir, name), 'utf8');
        try {
          records.push(JSON.parse(json) as AppCredentialsRecord);
        } catch { /* skip malformed */ }
      }
      return records;
    },
  };
}
