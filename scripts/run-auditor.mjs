#!/usr/bin/env node
/**
 * run-auditor: invoked from pr-landing workflow when a PR carries a
 * plan-id: <id> label. Fetches PR diff, classifies blast radius,
 * compares to intent envelope, writes:
 *   1. An observation atom (kind: 'auditor-plan-check') with the verdict.
 *   2. A GitHub Commit Status under context 'LAG-auditor' with state
 *      'success' (verdict=pass) or 'failure' (verdict=fail).
 *
 * Usage:
 *   node scripts/run-auditor.mjs --pr <number> --plan <plan-id>
 *
 * Exit codes:
 *   0 - verdict pass (status posted, atom written)
 *   1 - verdict fail (status posted, atom written)
 *   2 - invocation error (args, env, missing atom)
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { createFileHost } from '../dist/adapters/file/index.js';
import { classifyDiffBlastRadius, computeVerdict } from './lib/auditor.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');
const REPO = process.env.GH_REPO ?? 'stephengardner/layered-autonomous-governance';

function parseArgs(argv) {
  const a = { pr: null, plan: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pr' && i + 1 < argv.length) a.pr = argv[++i];
    else if (argv[i] === '--plan' && i + 1 < argv.length) a.plan = argv[++i];
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pr || !args.plan) {
    console.error('[auditor] usage: --pr <number> --plan <plan-id>');
    process.exit(2);
  }
  const host = await createFileHost({ rootDir: STATE_DIR });
  const plan = await host.atoms.get(args.plan);
  if (!plan || plan.type !== 'plan') {
    console.error(`[auditor] plan atom ${args.plan} not found or wrong type`);
    process.exit(2);
  }
  const intentId = (plan.provenance?.derived_from ?? []).find((id) => id.startsWith('intent-'));
  if (!intentId) {
    console.error('[auditor] plan has no intent in provenance; auditor gate only applies to intent-driven plans');
    process.exit(2);
  }
  const intent = await host.atoms.get(intentId);
  const envelopeMax = intent?.metadata?.trust_envelope?.max_blast_radius;
  if (!envelopeMax) {
    console.error('[auditor] intent missing trust_envelope.max_blast_radius');
    process.exit(2);
  }

  const { stdout } = await execa('gh', ['pr', 'view', args.pr, '--json', 'files', '--jq', '.files[].path']);
  const files = stdout.trim().split('\n').filter(Boolean);
  const diffRadius = classifyDiffBlastRadius(files);
  const { verdict, reason } = computeVerdict({ diffRadius, envelopeMax });
  console.log(`[auditor] plan=${args.plan} pr=${args.pr} diffRadius=${diffRadius} envelope=${envelopeMax} -> ${verdict}`);

  const nowIso = new Date().toISOString();
  const verdictAtom = {
    schema_version: 1,
    id: `auditor-plan-check-${args.plan}-${nowIso.replace(/[:.]/g, '-')}`,
    type: 'observation',
    layer: 'L1',
    principal_id: 'auditor-actor',
    provenance: {
      kind: 'agent-observed',
      source: { tool: 'run-auditor', agent_id: 'auditor-actor' },
      derived_from: [args.plan, intentId],
    },
    confidence: 1,
    scope: 'project',
    content: `Auditor verdict=${verdict}. ${reason}. diffRadius=${diffRadius} envelopeMax=${envelopeMax}.`,
    metadata: {
      kind: 'auditor-plan-check',
      verdict,
      reason,
      diff_files: files,
      diff_radius: diffRadius,
      envelope_max: envelopeMax,
      pr_number: Number(args.pr),
      plan_id: args.plan,
      intent_id: intentId,
    },
    created_at: nowIso,
    last_reinforced_at: nowIso,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    taint: 'clean',
    signals: { agrees_with: [], disagrees_with: [], refined_by: [] },
  };
  await host.atoms.put(verdictAtom);

  const { stdout: headSha } = await execa('gh', ['pr', 'view', args.pr, '--json', 'headRefOid', '--jq', '.headRefOid']);
  const sha = headSha.trim();
  const state = verdict === 'pass' ? 'success' : 'failure';
  await execa('gh', [
    'api', `repos/${REPO}/statuses/${sha}`,
    '-f', `state=${state}`,
    '-f', `context=LAG-auditor`,
    '-f', `description=${reason.slice(0, 140)}`,
  ]);
  console.log(`[auditor] LAG-auditor status posted: ${state}`);

  process.exit(verdict === 'pass' ? 0 : 1);
}

main().catch((err) => {
  console.error(`[auditor] ${err.message}`);
  process.exit(2);
});
