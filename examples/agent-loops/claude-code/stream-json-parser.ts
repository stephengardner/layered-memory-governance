/**
 * Pure NDJSON event parser for Claude Code CLI's `--output-format stream-json`.
 *
 * Each call to `parseStreamJsonLine(line)` returns exactly one event.
 * Malformed lines yield `{kind: 'parse-error'}` -- they MUST NOT throw,
 * because the adapter relies on parser-side defensiveness to keep the
 * loop alive through partial corruption.
 *
 * Oversize lines (> 10MB) are rejected up-front to bound memory.
 */

const OVERSIZE_LINE_BYTES = 10 * 1024 * 1024;

export type StreamJsonEvent =
  | { readonly kind: 'system'; readonly modelId: string | undefined; readonly sessionId: string | undefined }
  | { readonly kind: 'assistant-text'; readonly text: string }
  | { readonly kind: 'tool-use'; readonly toolUseId: string; readonly toolName: string; readonly input: unknown }
  | { readonly kind: 'tool-result'; readonly toolUseId: string; readonly content: string; readonly isError: boolean }
  | { readonly kind: 'result'; readonly costUsd: number | undefined; readonly isError: boolean }
  | { readonly kind: 'parse-error'; readonly reason: 'malformed-json' | 'unknown-type' | 'oversize-line' | 'empty'; readonly linePreview: string };

export function parseStreamJsonLine(line: string): StreamJsonEvent {
  if (line.length === 0) {
    return { kind: 'parse-error', reason: 'empty', linePreview: '' };
  }
  if (line.length > OVERSIZE_LINE_BYTES) {
    return { kind: 'parse-error', reason: 'oversize-line', linePreview: line.slice(0, 200) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: 'parse-error', reason: 'malformed-json', linePreview: line.slice(0, 200) };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { kind: 'parse-error', reason: 'malformed-json', linePreview: line.slice(0, 200) };
  }
  const obj = parsed as Record<string, unknown>;
  const type = obj['type'];
  if (type === 'system') {
    return {
      kind: 'system',
      modelId: typeof obj['model'] === 'string' ? (obj['model'] as string) : undefined,
      sessionId: typeof obj['session_id'] === 'string' ? (obj['session_id'] as string) : undefined,
    };
  }
  if (type === 'assistant') {
    const msg = obj['message'];
    if (msg !== null && typeof msg === 'object') {
      const content = (msg as Record<string, unknown>)['content'];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block === null || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b['type'] === 'text' && typeof b['text'] === 'string') {
            return { kind: 'assistant-text', text: b['text'] as string };
          }
          if (b['type'] === 'tool_use'
              && typeof b['id'] === 'string'
              && typeof b['name'] === 'string') {
            return {
              kind: 'tool-use',
              toolUseId: b['id'] as string,
              toolName: b['name'] as string,
              input: b['input'] ?? {},
            };
          }
        }
      }
    }
    return { kind: 'parse-error', reason: 'unknown-type', linePreview: line.slice(0, 200) };
  }
  if (type === 'user') {
    const msg = obj['message'];
    if (msg !== null && typeof msg === 'object') {
      const content = (msg as Record<string, unknown>)['content'];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block === null || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b['type'] === 'tool_result' && typeof b['tool_use_id'] === 'string') {
            const c = b['content'];
            const text = typeof c === 'string'
              ? c
              : (Array.isArray(c) ? c.map((x) => typeof x === 'object' && x !== null && 'text' in x ? String((x as { text: unknown }).text) : '').join('') : '');
            return {
              kind: 'tool-result',
              toolUseId: b['tool_use_id'] as string,
              content: text,
              isError: b['is_error'] === true,
            };
          }
        }
      }
    }
    return { kind: 'parse-error', reason: 'unknown-type', linePreview: line.slice(0, 200) };
  }
  if (type === 'result') {
    return {
      kind: 'result',
      costUsd: typeof obj['cost_usd'] === 'number' ? (obj['cost_usd'] as number) : undefined,
      isError: obj['is_error'] === true,
    };
  }
  return { kind: 'parse-error', reason: 'unknown-type', linePreview: line.slice(0, 200) };
}
