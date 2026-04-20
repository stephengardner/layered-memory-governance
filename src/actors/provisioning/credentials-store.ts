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

import { mkdir, readFile, writeFile, chmod, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

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

  const recordPath = (role: string) => join(appsDir, `${role}.json`);
  const keyPath = (role: string) => join(keysDir, `${role}.pem`);

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
      await mkdir(keysDir, { recursive: true });
      const rp = recordPath(record.role);
      const kp = keyPath(record.role);
      await writeFile(rp, JSON.stringify(record, null, 2) + '\n', 'utf8');
      await writeFile(kp, privateKey, { encoding: 'utf8', mode: 0o600 });
      // chmod again defensively; writeFile's mode is not honored on all platforms.
      try { await chmod(kp, 0o600); } catch { /* windows may reject */ }
    },

    async update(record) {
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
