import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HttpTransport } from './http';

/*
 * Regression test for the silent-SSE bug flagged by CodeRabbit on
 * PR #78: the server broadcasts named events (`atom.created`,
 * `atom.changed`, `atom.deleted`, `ping`, `open`) via SSE, but
 * EventSource.onmessage only fires for un-named `message` events.
 * Before the fix, every atom lifecycle event was discarded and
 * TanStack Query caches never invalidated — the UI showed stale
 * data indefinitely.
 *
 * We mock EventSource and assert that subscribe() registers a
 * listener for each named event the server can emit.
 */

interface StoredListener {
  readonly name: string;
  readonly handler: EventListener;
}

class FakeEventSource {
  readonly url: string;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  readonly listeners: StoredListener[] = [];
  closed = false;

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(name: string, handler: EventListener): void {
    this.listeners.push({ name, handler });
  }

  removeEventListener(name: string, handler: EventListener): void {
    const idx = this.listeners.findIndex((l) => l.name === name && l.handler === handler);
    if (idx >= 0) this.listeners.splice(idx, 1);
  }

  close(): void {
    this.closed = true;
  }

  dispatchNamed(name: string, data: unknown): void {
    for (const l of this.listeners) {
      if (l.name === name) {
        l.handler(new MessageEvent(name, { data: JSON.stringify(data) }));
      }
    }
  }
}

describe('HttpTransport.subscribe', () => {
  let fakes: FakeEventSource[] = [];

  beforeEach(() => {
    fakes = [];
    vi.stubGlobal('EventSource', class extends FakeEventSource {
      constructor(url: string) {
        super(url);
        fakes.push(this);
      }
    });
  });

  it('registers listeners for every named SSE event the server emits', () => {
    const t = new HttpTransport('/api');
    const onEvent = vi.fn();
    const unsubscribe = t.subscribe('atoms', onEvent);

    expect(fakes).toHaveLength(1);
    const names = new Set(fakes[0]!.listeners.map((l) => l.name));
    /*
     * These are the exact event names the server emits in
     * server/index.ts (`broadcastAtomEvent` + the open/ping on
     * connection). If the server adds a new one, this test fails
     * until it's added to SSE_EVENT_NAMES in http.ts.
     */
    expect(names.has('atom.created')).toBe(true);
    expect(names.has('atom.changed')).toBe(true);
    expect(names.has('atom.deleted')).toBe(true);
    expect(names.has('ping')).toBe(true);
    expect(names.has('open')).toBe(true);
    // Per-pipeline channel vocabulary: pipeline-detail SSE stream
    // emits dash-separated names that the same EventSource has to
    // handle on the pipeline.<id> channel.
    expect(names.has('atom-change')).toBe(true);
    expect(names.has('pipeline-state-change')).toBe(true);
    expect(names.has('heartbeat')).toBe(true);

    unsubscribe();
    expect(fakes[0]!.closed).toBe(true);
  });

  it('routes per-pipeline channel events through the same handler', () => {
    const t = new HttpTransport('/api');
    const onEvent = vi.fn();
    t.subscribe<{ pipeline_id: string }>('pipeline.pipeline-fixture-x', onEvent);

    fakes[0]!.dispatchNamed('open', { pipeline_id: 'pipeline-fixture-x', at: '2026-05-11T12:00:00.000Z' });
    fakes[0]!.dispatchNamed('atom-change', {
      pipeline_id: 'pipeline-fixture-x',
      atom_id: 'pipeline-stage-event-x',
      atom_type: 'pipeline-stage-event',
      at: '2026-05-11T12:00:01.000Z',
    });
    fakes[0]!.dispatchNamed('pipeline-state-change', {
      pipeline_id: 'pipeline-fixture-x',
      pipeline_state: 'running',
      at: '2026-05-11T12:00:02.000Z',
    });
    fakes[0]!.dispatchNamed('heartbeat', { at: '2026-05-11T12:00:03.000Z' });

    expect(onEvent).toHaveBeenCalledTimes(4);
  });

  it('targets /api/events/pipeline.<id> URL when called with a pipeline channel', () => {
    const t = new HttpTransport('/api');
    t.subscribe('pipeline.pipeline-abc-123', vi.fn());
    expect(fakes[0]!.url).toBe('/api/events/pipeline.pipeline-abc-123');
  });

  it('invokes onEvent for each named event that fires', () => {
    const t = new HttpTransport('/api');
    const onEvent = vi.fn();
    t.subscribe<{ id: string }>('atoms', onEvent);

    fakes[0]!.dispatchNamed('atom.created', { id: 'arch-x' });
    fakes[0]!.dispatchNamed('atom.changed', { id: 'arch-x' });
    fakes[0]!.dispatchNamed('atom.deleted', { id: 'arch-x' });

    expect(onEvent).toHaveBeenCalledTimes(3);
    expect(onEvent).toHaveBeenNthCalledWith(1, { id: 'arch-x' });
    expect(onEvent).toHaveBeenNthCalledWith(2, { id: 'arch-x' });
    expect(onEvent).toHaveBeenNthCalledWith(3, { id: 'arch-x' });
  });

  it('still handles un-named message events (defensive for future server changes)', () => {
    const t = new HttpTransport('/api');
    const onEvent = vi.fn();
    t.subscribe<{ id: string }>('atoms', onEvent);

    // Simulate an un-named message event (source.onmessage path).
    fakes[0]!.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ id: 'legacy' }) }));
    expect(onEvent).toHaveBeenCalledWith({ id: 'legacy' });
  });

  it('forwards parse errors to onError without breaking the stream', () => {
    const t = new HttpTransport('/api');
    const onEvent = vi.fn();
    const onError = vi.fn();
    t.subscribe('atoms', onEvent, onError);

    // Dispatch a malformed payload via a named event.
    const listener = fakes[0]!.listeners.find((l) => l.name === 'atom.created')!;
    listener.handler(new MessageEvent('atom.created', { data: '{malformed' }));

    expect(onError).toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('cleans up all listeners on unsubscribe', () => {
    const t = new HttpTransport('/api');
    const onEvent = vi.fn();
    const unsubscribe = t.subscribe('atoms', onEvent);
    expect(fakes[0]!.listeners.length).toBeGreaterThan(0);
    unsubscribe();
    expect(fakes[0]!.listeners.length).toBe(0);
    expect(fakes[0]!.closed).toBe(true);
  });
});
