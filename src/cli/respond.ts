#!/usr/bin/env node
/**
 * lag-respond: interactive CLI for adjudicating pending LAG notifications.
 *
 * Usage:
 *   lag-respond --root-dir <path> [--watch] [--responder <principal>]
 *
 * Walks `rootDir/notifier/pending/`, displays each event (summary + body +
 * optional diff), and accepts single-key input from stdin:
 *   a  approve (closes notifier ticket; no atom written)
 *   r  reject  (closes notifier ticket; no atom written)
 *   i  ignore
 *   v  vote    (writes a plan-approval-vote atom AND closes the notifier)
 *              only offered when the event references a plan atom
 *   s  skip (leave pending)
 *   q  quit
 *
 * --watch polls every 1s for new pending items. Without --watch, the tool
 * processes what exists now and exits.
 *
 * Exit codes:
 *   0  success (processed or nothing to do)
 *   1  argument error
 *   2  IO or unexpected error
 */

import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { createFileHost, type FileHost } from '../adapters/file/index.js';
import type { Disposition, NotificationHandle, PrincipalId } from '../types.js';
import {
  castVoteInteractive,
  resolvePlanIdFromAtomRefs,
} from './respond-vote.js';

interface CliArgs {
  readonly rootDir: string;
  readonly watch: boolean;
  readonly responder: string;
}

function parseCliArgs(): CliArgs | null {
  try {
    const { values } = parseArgs({
      options: {
        'root-dir': { type: 'string' },
        watch: { type: 'boolean', default: false },
        responder: { type: 'string', default: 'operator' },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
    if (values['help']) {
      printUsage();
      return null;
    }
    const rootDir = values['root-dir'];
    if (!rootDir) {
      console.error('Error: --root-dir is required.');
      printUsage();
      return null;
    }
    return {
      rootDir,
      watch: Boolean(values['watch']),
      responder: String(values['responder']),
    };
  } catch (err) {
    console.error('Error parsing args:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

function printUsage(): void {
  console.error(
    [
      'lag-respond: interactive CLI for LAG pending notifications.',
      '',
      'Usage: lag-respond --root-dir <path> [--watch] [--responder <principal>]',
      '',
      'Options:',
      '  --root-dir <path>    Root directory of the LAG host (required).',
      '  --watch              Poll for new pending items every 1s.',
      '  --responder <name>   Principal id recorded on your responses (default: "operator").',
      '  --help               Print this message.',
      '',
      'Dispositions:',
      '  a  approve (closes notifier ticket; no atom written)',
      '  r  reject  (closes notifier ticket; no atom written)',
      '  i  ignore',
      '  v  vote    (plan events only; writes plan-approval-vote atom + closes ticket)',
      '  s  skip    (leave pending for next run)',
      '  q  quit',
    ].join('\n'),
  );
}

/**
 * Read one line from the readline async iterator, writing the prompt query
 * to stdout first. Returns null if the underlying input stream has closed.
 *
 * Using the async iterator (instead of rl.question) is required to support
 * non-TTY piped stdin: question() throws ERR_USE_AFTER_CLOSE when the input
 * stream ends, while the iterator returns {done: true} cleanly.
 */
async function readLineWithPrompt(
  iter: AsyncIterableIterator<string>,
  query: string,
): Promise<string | null> {
  process.stdout.write(query);
  const next = await iter.next();
  if (next.done) return null;
  return next.value;
}

function dispositionFromInput(input: string): Disposition | 'skip' | 'quit' | 'vote' | null {
  const first = input.trim().toLowerCase().charAt(0);
  switch (first) {
    case 'a':
      return 'approve';
    case 'r':
      return 'reject';
    case 'i':
      return 'ignore';
    case 'v':
      return 'vote';
    case 's':
      return 'skip';
    case 'q':
      return 'quit';
    default:
      return null;
  }
}

function formatHandle(handle: NotificationHandle): string {
  const s = String(handle);
  return s.length > 16 ? `${s.slice(0, 12)}…${s.slice(-3)}` : s;
}

function formatTimeLeft(timeoutAt: number): string {
  const ms = timeoutAt - Date.now();
  if (ms <= 0) return 'expired';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

async function processHandle(
  host: FileHost,
  handle: NotificationHandle,
  responder: PrincipalId,
  lineIter: AsyncIterableIterator<string>,
): Promise<'processed' | 'skipped' | 'quit'> {
  const notifier = host.notifier;
  const entry = await notifier.getPendingEntry(handle);
  if (!entry) return 'skipped';

  // Resolve a plan atom id up front so we can show/hide the [v]ote
  // option. Scans atom_refs and picks the first whose type is 'plan'.
  // Null means this event isn't about a plan; [v] stays hidden.
  const planId = await resolvePlanIdFromAtomRefs(host, entry.event.atom_refs);

  console.log('');
  console.log('──────────────────────────────────────────────────────────────');
  console.log(`Handle:       ${formatHandle(handle)}`);
  console.log(`Kind:         ${entry.event.kind}`);
  console.log(`Severity:     ${entry.event.severity}`);
  console.log(`Principal:    ${entry.event.principal_id}`);
  console.log(`Created:      ${entry.event.created_at}`);
  console.log(`Timeout in:   ${formatTimeLeft(entry.timeoutAt)}  (default: ${entry.defaultDisposition})`);
  console.log(`Summary:      ${entry.event.summary}`);
  if (entry.event.atom_refs.length > 0) {
    console.log(`Atom refs:    ${entry.event.atom_refs.join(', ')}`);
  }
  if (entry.event.body) {
    console.log('');
    console.log('Body:');
    const indented = entry.event.body
      .split('\n')
      .map(l => '  ' + l)
      .join('\n');
    console.log(indented);
  }
  if (entry.diff) {
    console.log('');
    console.log(`Diff on ${entry.diff.path}:`);
    console.log('  --- before');
    console.log(entry.diff.before.split('\n').map(l => '  -' + l).join('\n'));
    console.log('  +++ after');
    console.log(entry.diff.after.split('\n').map(l => '  +' + l).join('\n'));
  }
  console.log('──────────────────────────────────────────────────────────────');

  const promptStr = planId !== null
    ? 'Disposition [a]pprove / [r]eject / [i]gnore / [v]ote / [s]kip / [q]uit: '
    : 'Disposition [a]pprove / [r]eject / [i]gnore / [s]kip / [q]uit: ';
  const answer = await readLineWithPrompt(lineIter, promptStr);
  if (answer === null) {
    console.log('\n(stdin closed)');
    return 'quit';
  }
  const decision = dispositionFromInput(answer);
  if (decision === null) {
    console.log(`Unrecognized input "${answer}". Skipping for now.`);
    return 'skipped';
  }
  if (decision === 'quit') {
    return 'quit';
  }
  if (decision === 'skip') {
    console.log('Skipped (still pending).');
    return 'skipped';
  }
  if (decision === 'vote') {
    if (planId === null) {
      console.log('This event has no plan atom ref; [v]ote is not applicable. Skipping.');
      return 'skipped';
    }
    // Scope must come from the plan atom, not inferred from the
    // notifier event. Atom.scope is the canonical source of truth
    // (the Event type has no scope field; the cast we were doing on
    // entry.event was unsafe and its fallback was a guess). Re-fetch
    // the plan here because the vote atom's scope needs to match the
    // plan's scope for scope-filtered canon renders to see the right
    // pair together.
    const planAtom = await host.atoms.get(planId);
    if (planAtom === null) {
      console.log('Plan atom disappeared before vote could be cast. Skipping.');
      return 'skipped';
    }
    const nowIso = host.clock.now();
    const voteResult = await castVoteInteractive(host, lineIter, {
      planId,
      voterId: responder,
      scope: planAtom.scope,
      nowIso,
    });
    if (voteResult === null) {
      console.log('Vote not cast. Notifier ticket left pending.');
      return 'skipped';
    }
    // Vote atom landed. Close the notifier ticket symmetrically so the
    // queue reflects that the operator has dispositioned this event.
    try {
      await notifier.respond(handle, voteResult.disposition, responder);
      console.log(
        `Vote cast: ${voteResult.disposition} (vote atom ${voteResult.voteAtomId}); notifier ticket closed.`,
      );
      return 'processed';
    } catch (err) {
      console.error(
        `Vote atom written (${voteResult.voteAtomId}) but failed to close notifier ticket: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 'skipped';
    }
  }
  try {
    await notifier.respond(handle, decision, responder);
    console.log(`Responded: ${decision}.`);
    return 'processed';
  } catch (err) {
    console.error(`Failed to respond: ${err instanceof Error ? err.message : String(err)}`);
    return 'skipped';
  }
}

async function mainLoop(args: CliArgs): Promise<number> {
  const host = await createFileHost({ rootDir: args.rootDir });
  const notifier = host.notifier;
  const responder = args.responder as PrincipalId;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lineIter = rl[Symbol.asyncIterator]();

  let exitCode = 0;
  let stop = false;

  const handleSigint = (): void => {
    console.log('');
    console.log('Interrupted. Exiting.');
    stop = true;
    rl.close(); // unblock any pending iter.next()
  };
  process.on('SIGINT', handleSigint);

  try {
    do {
      const handles = await notifier.listPending();
      if (handles.length === 0) {
        if (!args.watch) {
          console.log('No pending notifications.');
          break;
        }
        process.stdout.write('.');
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      if (args.watch) process.stdout.write('\n');
      for (const handle of handles) {
        if (stop) break;
        const outcome = await processHandle(host, handle, responder, lineIter);
        if (outcome === 'quit') {
          stop = true;
          break;
        }
      }
      if (!args.watch) break;
    } while (!stop);
  } catch (err) {
    console.error('Unexpected error:', err instanceof Error ? err.stack ?? err.message : String(err));
    exitCode = 2;
  } finally {
    rl.close();
    process.off('SIGINT', handleSigint);
  }
  return exitCode;
}

const args = parseCliArgs();
if (args === null) {
  process.exit(1);
}
const code = await mainLoop(args);
process.exit(code);
