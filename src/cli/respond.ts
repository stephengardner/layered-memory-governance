#!/usr/bin/env node
/**
 * lag-respond: interactive CLI for adjudicating pending LAG notifications.
 *
 * Usage:
 *   lag-respond --root-dir <path> [--watch] [--responder <principal>]
 *
 * Walks `rootDir/notifier/pending/`, displays each event (summary + body +
 * optional diff), and accepts single-key input from stdin:
 *   a  approve
 *   r  reject
 *   i  ignore
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
import { FileNotifier } from '../adapters/file/notifier.js';
import type { Disposition, NotificationHandle, PrincipalId } from '../substrate/types.js';

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

function dispositionFromInput(input: string): Disposition | 'skip' | 'quit' | null {
  const first = input.trim().toLowerCase().charAt(0);
  switch (first) {
    case 'a':
      return 'approve';
    case 'r':
      return 'reject';
    case 'i':
      return 'ignore';
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
  notifier: FileNotifier,
  handle: NotificationHandle,
  responder: PrincipalId,
  lineIter: AsyncIterableIterator<string>,
): Promise<'processed' | 'skipped' | 'quit'> {
  const entry = await notifier.getPendingEntry(handle);
  if (!entry) return 'skipped';

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

  const answer = await readLineWithPrompt(
    lineIter,
    'Disposition [a]pprove / [r]eject / [i]gnore / [s]kip / [q]uit: ',
  );
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
  const notifier = new FileNotifier(args.rootDir);
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
        const outcome = await processHandle(notifier, handle, responder, lineIter);
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
