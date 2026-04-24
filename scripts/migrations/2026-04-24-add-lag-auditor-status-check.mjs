#!/usr/bin/env node
/**
 * Migration: add LAG-auditor as a required status check on main.
 * Idempotent. Operator runs once POST-MERGE of the autonomous-intent PR.
 *
 * Usage:
 *   node scripts/migrations/2026-04-24-add-lag-auditor-status-check.mjs
 *
 * Requires: gh CLI with admin on the repo.
 */
import { execa } from 'execa';

const REPO = 'stephengardner/layered-autonomous-governance';
const BRANCH = 'main';
const CONTEXT = 'LAG-auditor';

async function main() {
  let protection;
  try {
    const cur = await execa('gh', ['api', `repos/${REPO}/branches/${BRANCH}/protection`]);
    protection = JSON.parse(cur.stdout);
  } catch (err) {
    console.error(`[migration] failed to read branch protection: ${err.message}`);
    process.exit(1);
  }
  const existingChecks = protection.required_status_checks?.checks ?? [];
  if (existingChecks.some((c) => c.context === CONTEXT)) {
    console.log(`[migration] ${CONTEXT} already in required_status_checks.checks; no change.`);
    return;
  }
  const nextChecks = [...existingChecks, { context: CONTEXT, app_id: -1 }];
  const body = JSON.stringify({
    checks: nextChecks,
    strict: protection.required_status_checks?.strict ?? true,
  });
  try {
    await execa('gh', [
      'api', `repos/${REPO}/branches/${BRANCH}/protection/required_status_checks`,
      '-X', 'PATCH',
      '--input', '-',
    ], { input: body });
  } catch (err) {
    console.error(`[migration] failed to PATCH required_status_checks: ${err.message}`);
    process.exit(1);
  }
  console.log(`[migration] added ${CONTEXT} to required_status_checks.checks. Now: ${nextChecks.map((c) => c.context).join(', ')}`);
}
main().catch((err) => { console.error(err); process.exit(1); });
