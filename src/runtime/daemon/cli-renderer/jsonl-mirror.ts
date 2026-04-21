/**
 * JsonlMirror: drive a CliRenderer from a Claude Code session jsonl.
 *
 * Claude Code writes each model/content block to the session file as
 * one JSON-per-line record. Tailing that file gives us a stream of
 * events we can translate into CliRendererEvents -- same primitive a
 * spawned `claude -p --output-format stream-json` path uses. The
 * difference from stream-json: the jsonl has NO terminal `result`
 * event, so turn-end is inferred from either (a) the appearance of
 * a new non-tool-result user record, or (b) inactivity after an
 * assistant text block.
 *
 * Intentionally framework-agnostic: knows nothing about Telegram or
 * LAG; consumes a CliRendererChannel + two format callbacks. LAG's
 * lag-terminal.mjs is the first consumer.
 */

import { readFile, stat, open as openFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { CliRenderer } from './renderer.js';
import type {
  CliRendererChannel,
  CliRendererEvent,
  InlineAction,
} from './types.js';
import { summarizeToolUse } from './claude-stream-parser.js';

export interface JsonlMirrorOptions {
  /** Absolute path to the session jsonl file. May not exist yet. */
  readonly filePath: string;
  /** Channel the renderer posts/edits through (e.g. TelegramChannel). */
  readonly channel: CliRendererChannel;
  /** Markdown-to-channel-format translator used on completion. */
  readonly renderFinal: (markdown: string) => string;
  /** Split callback for final messages longer than channel cap. */
  readonly splitFinal: (text: string) => ReadonlyArray<string>;
  /**
   * Throbber label prefix (e.g. 'Claude is working'). The renderer
   * appends the spinner frame + elapsed seconds on its own.
   */
  readonly label?: string;
  /**
   * Optional action button attached to each live throbber (e.g. Stop).
   * The mirror has no abort capability over a PTY child, so callers
   * typically omit this. Reserved for the future when we surface a
   * "nudge stop" signal.
   */
  readonly action?: InlineAction;
  /**
   * ms of inactivity after the most recent assistant text block before
   * we declare the turn done and finalize the renderer. Default 2000.
   * Tune up if your claude sessions frequently pause mid-turn for
   * long web-fetches or LLM calls.
   */
  readonly turnEndInactivityMs?: number;
  /** Poll interval for stat()/read. Default 800ms. */
  readonly pollIntervalMs?: number;
  /**
   * Injectable clock (ms). Defaults to Date.now. Tests use a stub so
   * heartbeat + inactivity timing is deterministic.
   */
  readonly now?: () => number;
  /** Log verbosely to stderr. Default false. */
  readonly verbose?: boolean;
}

export interface JsonlMirrorController {
  /** Stop tailing + dispose any active renderer. Idempotent. */
  readonly stop: () => Promise<void>;
}

/**
 * Start mirroring. The tail begins at END-OF-FILE so historical turns
 * from a resumed session are NEVER mirrored; only turns written after
 * the call to startJsonlMirror are surfaced.
 */
export function startJsonlMirror(opts: JsonlMirrorOptions): JsonlMirrorController {
  const now = opts.now ?? (() => Date.now());
  const inactivity = opts.turnEndInactivityMs ?? 2000;
  const pollMs = opts.pollIntervalMs ?? 800;
  const verbose = opts.verbose ?? false;

  let stopped = false;
  let attached = false;
  let offset = 0;
  let partial = '';
  const seenUuids = new Set<string>();

  let activeRenderer: CliRenderer | null = null;
  let lastTextAtMs = 0;
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const clearInactivity = (): void => {
    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
      inactivityTimer = null;
    }
  };

  const armInactivity = (): void => {
    clearInactivity();
    inactivityTimer = setTimeout(() => {
      void finalizeActiveTurn('inactivity');
    }, inactivity);
    if (typeof inactivityTimer.unref === 'function') inactivityTimer.unref();
  };

  const finalizeActiveTurn = async (cause: 'new-user-turn' | 'inactivity' | 'stop'): Promise<void> => {
    clearInactivity();
    const r = activeRenderer;
    activeRenderer = null;
    if (!r) return;
    if (verbose) console.error(`[mirror] finalize (${cause})`);
    // Emit a synthetic complete with the accumulated text. The
    // renderer ignores duplicate completes.
    await r.emit({ type: 'complete', finalText: rendererAccumulator.get(r) ?? '' });
    await r.dispose();
    rendererAccumulator.delete(r);
  };

  const ensureRenderer = (): CliRenderer => {
    if (activeRenderer !== null) return activeRenderer;
    activeRenderer = new CliRenderer({
      channel: opts.channel,
      now,
      renderFinal: opts.renderFinal,
      splitFinal: opts.splitFinal,
      ...(opts.action ? { action: opts.action } : {}),
    });
    rendererAccumulator.set(activeRenderer, '');
    // Fire-and-forget the start emit; errors are caught inside CliRenderer.
    void activeRenderer.emit({
      type: 'start',
      ...(opts.label ? { label: opts.label } : {}),
    });
    return activeRenderer;
  };

  const feed = async (event: CliRendererEvent, textForFinal?: string): Promise<void> => {
    const r = ensureRenderer();
    if (textForFinal !== undefined) {
      rendererAccumulator.set(r, (rendererAccumulator.get(r) ?? '') + textForFinal);
    }
    await r.emit(event);
  };

  const handleJsonl = async (obj: unknown): Promise<void> => {
    if (!obj || typeof obj !== 'object') return;
    const rec = obj as Record<string, unknown>;
    const uuid = typeof rec.uuid === 'string' ? rec.uuid : null;
    if (uuid && seenUuids.has(uuid)) return;
    if (uuid) seenUuids.add(uuid);

    if (rec.type === 'user') {
      const msg = rec.message as { content?: unknown } | undefined;
      const content = msg?.content;
      // A tool_result user record stays inside the current turn.
      // Anything else (plain user prompt) is the start of a new turn.
      const isToolResultOnly = Array.isArray(content)
        && content.length > 0
        && content.every((b) => isRecord(b) && b.type === 'tool_result');
      if (!isToolResultOnly) {
        // New operator-origin turn; finalize any active turn first.
        await finalizeActiveTurn('new-user-turn');
        return;
      }
      // Tool result: forward to the active renderer if any. Re-arm
      // the inactivity timer: a tool just completed, which is a
      // legitimate sign of progress and also likely to be followed by
      // more assistant text or another tool call. Without this, a run
      // that does text -> tool_use -> (tool runs for 2x inactivity
      // window) -> tool_result -> text would get synthetically
      // completed mid-turn because only text re-armed the timer.
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!isRecord(b) || b.type !== 'tool_result') continue;
          await feed({
            type: 'tool-result',
            tool: 'tool',
            ok: b.is_error !== true,
            ...(summarizeToolResult(b.content) === undefined
              ? {}
              : { summary: summarizeToolResult(b.content)! }),
          });
          armInactivity();
        }
      }
      return;
    }

    if (rec.type === 'assistant') {
      const msg = rec.message as { content?: unknown } | undefined;
      const content = msg?.content;
      if (!Array.isArray(content)) return;
      for (const b of content) {
        if (!isRecord(b)) continue;
        if (b.type === 'text' && typeof b.text === 'string') {
          await feed({ type: 'text-delta', text: b.text }, b.text);
          lastTextAtMs = now();
          armInactivity();
          continue;
        }
        if (b.type === 'thinking' && typeof b.thinking === 'string') {
          await feed({ type: 'thinking', text: b.thinking });
          continue;
        }
        if (b.type === 'tool_use' && typeof b.name === 'string') {
          await feed({
            type: 'tool-call',
            tool: b.name,
            summary: summarizeToolUse(b.name, (isRecord(b.input) ? b.input : {})),
          });
          // Re-arm so the tool's own run time does not cause a
          // premature synthetic completion. The matching tool_result
          // will re-arm again on arrival.
          armInactivity();
          continue;
        }
      }
      return;
    }
    // Ignore system/meta records.
  };

  const tickPoll = async (): Promise<void> => {
    if (stopped) return;
    try {
      if (!existsSync(opts.filePath)) {
        pollTimer = setTimeout(() => { void tickPoll(); }, pollMs);
        if (typeof pollTimer.unref === 'function') pollTimer.unref();
        return;
      }

      if (!attached) {
        const s0 = await stat(opts.filePath);
        // Seed seenUuids from historical records so nothing pre-startup
        // ever mirrors, even if the writer appends out-of-order.
        try {
          const existing = await readFile(opts.filePath, 'utf8');
          for (const line of existing.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
              const o = JSON.parse(line);
              if (o && typeof o === 'object' && typeof o.uuid === 'string') {
                seenUuids.add(o.uuid);
              }
            } catch { /* skip */ }
          }
        } catch { /* fine */ }
        offset = s0.size;
        attached = true;
        if (verbose) console.error(`[mirror] attached at EOF offset=${s0.size}, skipping ${seenUuids.size} historical records`);
      }

      const s = await stat(opts.filePath);
      if (s.size > offset) {
        const fh = await openFile(opts.filePath, 'r');
        try {
          const length = s.size - offset;
          const buf = Buffer.alloc(length);
          await fh.read(buf, 0, length, offset);
          offset = s.size;
          const chunk = partial + buf.toString('utf8');
          const lines = chunk.split(/\r?\n/);
          partial = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            let obj: unknown;
            try { obj = JSON.parse(line); } catch { continue; }
            try {
              await handleJsonl(obj);
            } catch (err) {
              if (verbose) console.error('[mirror] handleJsonl threw:', err instanceof Error ? err.message : err);
            }
          }
        } finally {
          await fh.close();
        }
      }
    } catch (err) {
      if (verbose) console.error('[mirror] tick error:', err instanceof Error ? err.message : err);
    } finally {
      if (!stopped) {
        pollTimer = setTimeout(() => { void tickPoll(); }, pollMs);
        if (typeof pollTimer.unref === 'function') pollTimer.unref();
      }
    }
  };

  pollTimer = setTimeout(() => { void tickPoll(); }, 500);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      await finalizeActiveTurn('stop');
    },
  };
}

// ---- internals ---------------------------------------------------------

const rendererAccumulator = new WeakMap<CliRenderer, string>();

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function summarizeToolResult(content: unknown): string | undefined {
  if (typeof content === 'string') {
    const first = content.split('\n', 1)[0] ?? '';
    return first.length > 80 ? first.slice(0, 79) + '…' : first;
  }
  if (Array.isArray(content)) {
    for (const b of content) {
      if (isRecord(b) && typeof b.text === 'string') {
        const first = b.text.split('\n', 1)[0] ?? '';
        return first.length > 80 ? first.slice(0, 79) + '…' : first;
      }
    }
  }
  return undefined;
}
