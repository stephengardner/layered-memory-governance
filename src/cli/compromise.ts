#!/usr/bin/env node
/**
 * lag-compromise: operator CLI for marking a principal compromised and
 * propagating taint to their atoms + downstream derivations.
 *
 * Usage:
 *   lag-compromise --root-dir <path> --principal <id> --reason <text>
 *                  [--responder <id>]      # default 'operator'
 *                  [--yes]                 # bypass interactive confirm
 *
 * Exits 0 on success, 1 on argument error / principal-not-found / user
 * abort, 2 on unexpected error.
 *
 * Taint propagation is fail-safe and irreversible at the atom level; a
 * tainted atom stays tainted until a human explicitly un-marks it (no
 * such tool is shipped; do it via direct atom.taint update if needed).
 * So the default posture is a confirmation prompt. Scripts pass --yes.
 */

import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { createFileHost } from '../adapters/file/index.js';
import { propagateCompromiseTaint } from '../taint/propagate.js';
import type { PrincipalId } from '../substrate/types.js';

interface CliArgs {
  readonly rootDir: string;
  readonly principal: string;
  readonly reason: string;
  readonly responder: string;
  readonly yes: boolean;
}

function parseCliArgs(): CliArgs | null {
  try {
    const { values } = parseArgs({
      options: {
        'root-dir': { type: 'string' },
        principal: { type: 'string' },
        reason: { type: 'string' },
        responder: { type: 'string', default: 'operator' },
        yes: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
    if (values['help']) {
      printUsage();
      return null;
    }
    const rootDir = values['root-dir'];
    const principal = values['principal'];
    const reason = values['reason'];
    if (!rootDir || !principal || !reason) {
      console.error(
        'Error: --root-dir, --principal, and --reason are all required.',
      );
      printUsage();
      return null;
    }
    return {
      rootDir,
      principal,
      reason,
      responder: String(values['responder']),
      yes: Boolean(values['yes']),
    };
  } catch (err) {
    console.error('Error parsing args:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

function printUsage(): void {
  console.error(
    [
      'lag-compromise: mark a principal compromised and propagate taint.',
      '',
      'Usage: lag-compromise --root-dir <path> --principal <id> --reason <text> [options]',
      '',
      'Options:',
      '  --root-dir <path>     Root directory of the LAG host (required).',
      '  --principal <id>      Principal id to mark compromised (required).',
      '  --reason <text>       Human-readable reason, recorded in audit (required).',
      '  --responder <id>      Principal id running the command (default: "operator").',
      '  --yes                 Skip interactive confirmation (for scripts).',
      '  --help                Print this message.',
      '',
      'Effect:',
      '  1. Marks principal.compromised_at = now and deactivates them.',
      '  2. Marks every atom by that principal with created_at >= compromised_at',
      '     as taint="tainted".',
      '  3. Transitively taints every downstream atom via provenance.derived_from',
      '     chains to fixpoint.',
      '  4. Audits each transition as kind="atom.tainted".',
      '',
      'Taint is fail-safe (irreversible at the atom layer). Confirm carefully.',
    ].join('\n'),
  );
}

async function promptYes(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const iter = rl[Symbol.asyncIterator]();
    process.stdout.write(question);
    const next = await iter.next();
    if (next.done) return false;
    const answer = next.value.trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function formatHandleList(ids: ReadonlyArray<string>, maxShown: number = 20): string {
  if (ids.length === 0) return '(none)';
  const shown = ids.slice(0, maxShown);
  const lines = shown.map(id => `  - ${id}`);
  if (ids.length > maxShown) {
    lines.push(`  ... (${ids.length - maxShown} more)`);
  }
  return lines.join('\n');
}

async function main(): Promise<number> {
  const args = parseCliArgs();
  if (args === null) return 1;

  const host = await createFileHost({ rootDir: args.rootDir });
  const principalId = args.principal as PrincipalId;
  const principal = await host.principals.get(principalId);
  if (!principal) {
    console.error(`Principal "${args.principal}" not found at ${args.rootDir}.`);
    console.error('List existing principals with your own tool or inspect the directory directly.');
    return 1;
  }

  console.log('──────────────────────────────────────────────────────────────');
  console.log(`Principal:      ${principal.id}`);
  console.log(`Name:           ${principal.name}`);
  console.log(`Role:           ${principal.role}`);
  console.log(`Active:         ${principal.active}`);
  console.log(`Compromised at: ${principal.compromised_at ?? '(not currently)'}`);
  console.log(`Created at:     ${principal.created_at}`);
  console.log('──────────────────────────────────────────────────────────────');
  console.log(`Reason:         ${args.reason}`);
  console.log(`Responder:      ${args.responder}`);
  console.log('');
  console.log('EFFECT: this principal will be marked compromised and taint will');
  console.log('propagate to every atom they wrote at/after now, plus every');
  console.log('downstream derivation. Taint is fail-safe / irreversible.');
  console.log('');

  const alreadyCompromised = principal.compromised_at !== null;
  if (alreadyCompromised) {
    console.log(`Note: principal is already compromised (at ${principal.compromised_at}).`);
    console.log('Proceeding will re-run taint propagation; no double-tainting.');
    console.log('');
  }

  if (!args.yes) {
    const ok = await promptYes('Proceed? [y/N]: ');
    if (!ok) {
      console.log('Aborted. No changes made.');
      return 1;
    }
  }

  if (!alreadyCompromised) {
    const now = host.clock.now();
    await host.principals.markCompromised(principalId, now, args.reason);
    console.log(`Marked ${args.principal} compromised at ${now}.`);
  }

  const report = await propagateCompromiseTaint(
    host,
    principalId,
    args.responder as PrincipalId,
  );

  console.log('');
  console.log('Taint propagation report:');
  console.log(`  atoms tainted:  ${report.atomsTainted}`);
  console.log(`  atoms scanned:  ${report.atomsScanned}`);
  console.log(`  iterations:     ${report.iterations}`);
  if (report.atomsTainted > 0) {
    console.log('');
    console.log('Tainted atom ids:');
    console.log(formatHandleList(report.taintedAtomIds.map(id => String(id))));
    console.log('');
    console.log('These atoms will no longer appear in rendered canon on the next');
    console.log('lag-run-loop tick. Review the canon target file afterward.');
  }

  return 0;
}

const exitCode = await main().catch(err => {
  console.error('fatal:', err instanceof Error ? err.stack ?? err.message : String(err));
  return 2;
});
process.exit(exitCode);
