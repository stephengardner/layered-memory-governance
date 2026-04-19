#!/usr/bin/env node
/**
 * LAG terminal wrapper (Phase 51a).
 *
 * Launches an interactive Claude Code session as a PTY child AND
 * simultaneously long-polls Telegram. Incoming Telegram messages
 * are injected directly into the child's stdin, so the agent sees
 * them as if you typed them in the terminal. Result: real-time
 * bidirectional sessions where you can be at the computer OR on
 * your phone, same flow, same session, same jsonl.
 *
 * What this gives you that the daemon+hook setup does not:
 *   - No turn-boundary wait. As soon as the daemon reads a TG
 *     message, it is injected into the live Claude Code stdin
 *     within one tick. No waiting for a prior Stop hook to fire.
 *   - The agent's response streams to the real terminal output
 *     AS it is generated. You see progress live.
 *   - Same terminal is the primary; Telegram is a remote mouth.
 *
 * Usage:
 *   node scripts/lag-terminal.mjs [--resume-session <id>] [--no-mirror]
 *                                 [--claude-args "..."]
 *
 * Options:
 *   --resume-session <id>   Resume a specific Claude Code session id.
 *                           Default: launches a fresh session.
 *   --no-mirror             Do not mirror Claude's responses to
 *                           Telegram. (Default: mirror on.)
 *   --claude-args "<args>"  Extra args passed to the claude command
 *                           (space-separated, single-quoted).
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN      Required.
 *   TELEGRAM_CHAT_ID        Required. Operator's chat id.
 *   LAG_OPERATOR_ID         Optional; defaults to 'stephen-human'.
 *
 * Prereqs:
 *   - Claude CLI installed and authenticated (claude /login).
 *   - node-pty installed (npm i node-pty; already a LAG dep).
 *
 * Stop: Ctrl-C in the wrapper terminal. The child claude process is
 * killed cleanly; the Telegram poller is stopped.
 */

import { spawn as ptySpawn } from 'node-pty';
import { readFile, readdir, stat, open as openFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// .env loader (shared shape with other scripts).
// ---------------------------------------------------------------------------

async function loadDotEnv() {
  try {
    const text = await readFile(resolve(REPO_ROOT, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    /* optional */
  }
}

// ---------------------------------------------------------------------------
// Argument parsing.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    resumeSessionId: null,
    mirror: true,
    claudeArgs: [],
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--resume-session' && i + 1 < argv.length) {
      args.resumeSessionId = argv[++i];
    } else if (a === '--no-mirror') {
      args.mirror = false;
    } else if (a === '--claude-args' && i + 1 < argv.length) {
      args.claudeArgs = argv[++i].split(/\s+/).filter(Boolean);
    } else if (a === '--verbose') {
      args.verbose = true;
    } else if (a === '-h' || a === '--help') {
      console.log(`Usage: node scripts/lag-terminal.mjs [options]

Launches Claude Code as a PTY child with embedded Telegram polling.
Incoming Telegram messages inject directly into the Claude Code stdin.

Options:
  --resume-session <id>   Resume a specific session (passes --resume to claude)
  --no-mirror             Do not mirror Claude responses to Telegram (default: on)
  --claude-args "..."     Extra args for claude (space-separated)
  --verbose               Log Telegram poll activity + injection events
  -h, --help              This help`);
      process.exit(0);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Telegram long-poller.
// ---------------------------------------------------------------------------

class TelegramInjector {
  constructor({ botToken, chatId, onMessage, onError, verbose }) {
    this.botToken = botToken;
    this.chatId = String(chatId);
    this.onMessage = onMessage;
    this.onError = onError ?? ((err, ctx) => console.error(`[tg] ${ctx}:`, err.message || err));
    this.verbose = !!verbose;
    this.updateOffset = 0;
    this.running = false;
    this.pollTimer = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.pollOnce();
      } catch (err) {
        this.onError(err, 'pollOnce');
      }
      if (!this.running) return;
      this.pollTimer = setTimeout(loop, 2000);
    };
    void loop();
  }

  stop() {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async pollOnce() {
    const url = `https://api.telegram.org/bot${this.botToken}/getUpdates?offset=${this.updateOffset}&timeout=0&limit=50`;
    const res = await fetch(url);
    const json = await res.json();
    if (!json.ok) {
      throw new Error(`getUpdates: ${json.description ?? 'unknown'}`);
    }
    const updates = json.result ?? [];
    for (const update of updates) {
      if (update.update_id >= this.updateOffset) {
        this.updateOffset = update.update_id + 1;
      }
      const m = update.message;
      if (!m || typeof m.text !== 'string' || m.text.length === 0) continue;
      if (String(m.chat.id) !== this.chatId) continue;
      if (this.verbose) {
        console.error(`[tg] inbound #${m.message_id}: ${m.text.slice(0, 60)}`);
      }
      try {
        await this.onMessage({
          text: m.text,
          messageId: m.message_id,
          date: m.date,
          replyTo: m.reply_to_message?.message_id ?? null,
          fromUsername: m.from?.username ?? null,
        });
      } catch (err) {
        this.onError(err, 'onMessage');
      }
    }
  }

  async sendMessage(text) {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const body = {
      chat_id: this.chatId,
      text,
      disable_web_page_preview: true,
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) {
      throw new Error(`sendMessage: ${json.description ?? 'unknown'}`);
    }
    return json.result;
  }
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main() {
  await loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    console.error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing in .env. Aborting.');
    process.exit(1);
  }

  const claudeCmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  const claudeArgs = [];
  if (args.resumeSessionId) {
    claudeArgs.push('--resume', args.resumeSessionId);
  }
  claudeArgs.push(...args.claudeArgs);

  console.log(`LAG terminal wrapper starting`);
  console.log(`  Claude command:  ${claudeCmd} ${claudeArgs.join(' ') || '(interactive, new session)'}`);
  console.log(`  Telegram chat:   ${chatId}`);
  console.log(`  Mirror responses:${args.mirror ? ' ON' : ' OFF'}`);
  console.log(`  Stop:            Ctrl-C (both claude and the poller unwind)`);
  console.log('');

  // Start Claude Code inside a PTY so its TUI renders correctly.
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 30;
  const child = ptySpawn(claudeCmd, claudeArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: REPO_ROOT,
    env: process.env,
  });

  // Pipe PTY output to real stdout so the user sees everything.
  child.onData((data) => {
    process.stdout.write(data);
  });
  child.onExit(({ exitCode }) => {
    injector.stop();
    process.exit(exitCode ?? 0);
  });

  // Pipe real stdin (user's keystrokes) into PTY. Raw mode so arrow
  // keys / ctrl sequences pass through.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.on('data', (data) => {
    child.write(data.toString());
  });

  // Resize the PTY when the real terminal resizes.
  process.stdout.on('resize', () => {
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 30;
    try { child.resize(cols, rows); } catch { /* ignore */ }
  });

  // Mirror: tail the session's jsonl file instead of scraping PTY
  // output. The jsonl is the authoritative record of Claude's turns,
  // written atomically at turn boundaries. This gives us exact
  // assistant text (no spinner glyphs, no TUI redraw artifacts, no
  // timing heuristics).
  //
  // We poll the file every 1s, reading any new bytes appended since
  // last check, parsing JSONL records, and forwarding `assistant`
  // entries' text blocks to Telegram. Skip `thinking`, `tool_use`,
  // and `tool_result` blocks; those are operational noise.
  //
  // The session file path is determined from the resumed session id
  // (when --resume-session is passed) or detected by watching for
  // the newest jsonl in the current project's projects dir.
  const mirrorMinChars = 40;
  let mirrorController = null;
  if (args.mirror) {
    mirrorController = startJsonlMirror({
      repoRoot: REPO_ROOT,
      resumeSessionId: args.resumeSessionId,
      onText: async (text) => {
        if (text.length < mirrorMinChars) return;
        try {
          await injector.sendMessage(chunkForTelegram(text));
        } catch (err) {
          if (args.verbose) console.error('[tg] mirror send failed:', err.message);
        }
      },
      verbose: args.verbose,
    });
  }

  // The injector: on each Telegram message, write it to the PTY.
  //
  // How terminals tell a TUI "this is a paste, not keystrokes":
  // bracketed paste mode (xterm ctlseqs, DEC mode 2004). When the
  // TUI enables it (by emitting `ESC[?2004h`), any real terminal
  // wraps pasted text in start/end markers:
  //
  //   ESC [ 2 0 0 ~                      (paste start, 6 bytes)
  //   <the pasted body, verbatim>
  //   ESC [ 2 0 1 ~                      (paste end)
  //
  // Inside the markers, Enter = newline in the input buffer.
  // Outside, Enter = submit. This is exactly the semantic we want,
  // and it is deterministic: no timing heuristics, no paste-vs-type
  // detection based on byte arrival rate.
  //
  // Our sequence is therefore:
  //   1. write ESC[200~
  //   2. write the body (with any embedded ESC[201~ neutralized so
  //      malicious or incidental content cannot close the paste early)
  //   3. write ESC[201~
  //   4. write '\r' (one Enter keypress, outside paste = submit)
  //
  // All four writes go through the same PTY so ordering is preserved
  // by the child's read side.
  const PASTE_START = '\x1b[200~';
  const PASTE_END = '\x1b[201~';

  const injector = new TelegramInjector({
    botToken,
    chatId,
    verbose: args.verbose,
    onMessage: async ({ text }) => {
      // Strip trailing CR/LF the user may have added in TG; submission
      // is controlled by our explicit '\r' below.
      const raw = text.replace(/[\r\n]+$/g, '');
      // Neutralize any accidental paste-end sequences in the body.
      const body = raw.split(PASTE_END).join('');
      child.write(PASTE_START);
      child.write(body);
      child.write(PASTE_END);
      child.write('\r');
      if (args.verbose) {
        console.error(`[tg] injected + submitted (${body.length} chars via bracketed paste)`);
      }
    },
    onError: (err, ctx) => {
      if (args.verbose) console.error(`[tg] ${ctx}:`, err.message);
    },
  });
  injector.start();

  const shutdown = () => {
    injector.stop();
    if (mirrorController) mirrorController.stop();
    try { child.kill(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep the process alive via the child + stdin streams.
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function chunkForTelegram(text, max = 4000) {
  if (text.length <= max) return text;
  return text.slice(0, max - 40) + '\n\n...[truncated in mirror]';
}

/**
 * Start tailing the session's jsonl file for assistant turn outputs.
 * Returns a { stop } controller.
 *
 * Polls every 1s. Reads only bytes appended since last check so the
 * poll cost is bounded even for long sessions. Parses each appended
 * line as JSON, forwards `assistant` messages' text blocks to the
 * supplied onText callback.
 *
 * Path resolution:
 *   - If resumeSessionId given: watch
 *     ~/.claude/projects/<sanitized-cwd>/<resumeSessionId>.jsonl
 *     as soon as it exists.
 *   - Else: detect the session file by finding the newest-mtime jsonl
 *     in the project dir that wasn't there at wrapper start. Up to a
 *     30s wait; gives up quietly if none appears.
 */
function startJsonlMirror({ repoRoot, resumeSessionId, onText, verbose }) {
  const projectsRoot = join(homedir(), '.claude', 'projects');
  const sanitized = repoRoot.replace(/[:\\/]/g, '-');
  const projectDir = join(projectsRoot, sanitized);

  const state = {
    filePath: null,
    offset: 0,
    partial: '', // last incomplete line, if any
    seenUuids: new Set(),
    timer: null,
    wallStart: Date.now(),
    initialSnapshot: new Set(),
    running: true,
    // Seek-to-end flag: on the first attach to a jsonl file, we set
    // offset = current size so historical assistant turns (from a
    // prior resumed session) are NOT mirrored. Only turns written
    // *after* wrapper start are forwarded.
    attached: false,
  };

  // If resume id given, we know the target file directly.
  if (resumeSessionId) {
    state.filePath = join(projectDir, `${resumeSessionId}.jsonl`);
  } else {
    // Snapshot current jsonls so a new one (the session we're about
    // to launch) can be distinguished when it appears.
    try {
      const entries = readdirSync(projectDir).filter((n) => n.endsWith('.jsonl'));
      for (const e of entries) state.initialSnapshot.add(e);
    } catch {
      // project dir may not exist yet; fine
    }
  }

  const tick = async () => {
    if (!state.running) return;
    try {
      if (!state.filePath || !existsSync(state.filePath)) {
        // Detect mode: find a new jsonl that appeared since start.
        if (!resumeSessionId) {
          try {
            const entries = await readdir(projectDir);
            const jsonls = entries.filter((n) => n.endsWith('.jsonl'));
            const fresh = jsonls.filter((n) => !state.initialSnapshot.has(n));
            if (fresh.length > 0) {
              // Pick the most-recently-modified fresh file.
              let best = null;
              for (const n of fresh) {
                const s = await stat(join(projectDir, n));
                if (!best || s.mtimeMs > best.mtime) {
                  best = { path: join(projectDir, n), mtime: s.mtimeMs };
                }
              }
              state.filePath = best.path;
              if (verbose) console.error(`[mirror] tailing ${state.filePath}`);
            } else if (Date.now() - state.wallStart > 30_000) {
              // Give up detecting after 30s.
              state.running = false;
              return;
            }
          } catch {
            // project dir not yet present
          }
        }
        if (state.running && state.filePath === null) {
          state.timer = setTimeout(tick, 1_000);
          return;
        }
        if (!existsSync(state.filePath)) {
          state.timer = setTimeout(tick, 1_000);
          return;
        }
        if (verbose) console.error(`[mirror] tailing ${state.filePath}`);
      }

      // On first attach, seek to EOF and also register every existing
      // assistant uuid as "seen" so nothing historical is ever mirrored,
      // even if the writer rewrites or appends out-of-order.
      if (!state.attached) {
        const s0 = await stat(state.filePath);
        try {
          const existing = await readFile(state.filePath, 'utf8');
          for (const line of existing.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              if (obj.type === 'assistant' && typeof obj.uuid === 'string') {
                state.seenUuids.add(obj.uuid);
              }
            } catch { /* skip malformed */ }
          }
        } catch { /* fine, we will still skip via offset */ }
        state.offset = s0.size;
        state.attached = true;
        if (verbose) console.error(`[mirror] attached at EOF (${s0.size} bytes, ${state.seenUuids.size} historical assistant turns skipped)`);
      }

      // Read appended bytes since last offset.
      const s = await stat(state.filePath);
      if (s.size > state.offset) {
        const fh = await openFile(state.filePath, 'r');
        try {
          const length = s.size - state.offset;
          const buf = Buffer.alloc(length);
          await fh.read(buf, 0, length, state.offset);
          state.offset = s.size;
          const chunk = state.partial + buf.toString('utf8');
          const lines = chunk.split(/\r?\n/);
          state.partial = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            let obj;
            try { obj = JSON.parse(line); } catch { continue; }
            if (obj.type !== 'assistant') continue;
            const uuid = typeof obj.uuid === 'string' ? obj.uuid : null;
            if (uuid && state.seenUuids.has(uuid)) continue;
            if (uuid) state.seenUuids.add(uuid);
            const text = extractAssistantText(obj.message);
            if (text && text.trim().length > 0) {
              try { await onText(text); } catch (e) { if (verbose) console.error('[mirror] onText threw:', e.message); }
            }
          }
        } finally {
          await fh.close();
        }
      }
    } catch (err) {
      if (verbose) console.error('[mirror] tick error:', err.message);
    } finally {
      if (state.running) state.timer = setTimeout(tick, 1_000);
    }
  };

  state.timer = setTimeout(tick, 500);

  return {
    stop() {
      state.running = false;
      if (state.timer) clearTimeout(state.timer);
    },
  };
}

/**
 * Extract the text content from an assistant message body. Skips
 * `thinking`, `tool_use`, `tool_result`. Concatenates multiple text
 * blocks with blank lines between.
 */
function extractAssistantText(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) {
      parts.push(b.text);
    }
  }
  return parts.join('\n\n').trim();
}

main().catch((err) => {
  console.error('lag-terminal failed:', err);
  process.exit(1);
});
