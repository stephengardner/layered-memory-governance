/**
 * Shared test fixtures for agentic stage adapters.
 *
 * Extracted at N=2 per dev-duplication-floor: makeStubAdapter and
 * makeBundle were duplicated across the helper test, the agentic
 * brainstorm test, and the killer-pipeline E2E test. Centralising the
 * stubs keeps the per-test surface focused on the assertions, and a
 * future agentic stage adapter test (spec/plan/review) reuses the
 * fixtures without copy-pasting another stub.
 *
 * Not a public-surface module: lives under test/examples/ and is
 * imported only by sibling test files.
 */

import { createHash } from 'node:crypto';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import {
  blobRefFromHash,
  type BlobStore,
} from '../../../src/substrate/blob-store.js';
import type { Redactor } from '../../../src/substrate/redactor.js';
import type {
  Workspace,
  WorkspaceProvider,
} from '../../../src/substrate/workspace-provider.js';
import type {
  AgentLoopAdapter,
  AgentLoopInput,
  AgentLoopResult,
} from '../../../src/substrate/agent-loop.js';
import type {
  AgentSessionMeta,
  AgentTurnMeta,
  Atom,
  AtomId,
  PrincipalId,
  Time,
} from '../../../src/substrate/types.js';

const NOW: Time = '2026-05-01T00:00:00.000Z' as Time;

export interface StubAdapterRecorder {
  lastInput?: AgentLoopInput;
}

/**
 * Build a stub AgentLoopAdapter that writes deterministic
 * agent-session + agent-turn atoms with the supplied final-output
 * strings. The adapter records its last input on the optional
 * recorder so tests can assert what the helper passed in.
 *
 * `outputs` is an array of strings; one agent-turn atom is written
 * per entry, each carrying the corresponding string as
 * AgentTurnMeta.llm_output. The last turn's llm_output is what the
 * runStageAgentLoop helper reads as the stage's final output.
 */
export function makeStubAdapter(opts: {
  outputs: ReadonlyArray<string>;
  recorder?: StubAdapterRecorder;
}): AgentLoopAdapter {
  const recorder = opts.recorder ?? {};
  return {
    capabilities: {
      tracks_cost: true,
      supports_signal: true,
      classify_failure: () => 'structural',
    },
    async run(input: AgentLoopInput): Promise<AgentLoopResult> {
      recorder.lastInput = input;
      // Use crypto.randomBytes for the session-id suffix even in test
      // fixtures: keeps the security profile uniform across the codebase
      // and silences CodeQL's insecure-randomness check on test code.
      const { randomBytes } = await import('node:crypto');
      const sessionId =
        `agent-session-${input.correlationId}-${randomBytes(4).toString('hex')}` as AtomId;
      const sessionAtom: Atom = {
        schema_version: 1,
        id: sessionId,
        content: 'stub-session',
        type: 'agent-session',
        layer: 'L0',
        provenance: {
          kind: 'agent-observed',
          source: {
            tool: 'stub',
            agent_id: String(input.principal),
            session_id: input.correlationId,
          },
          derived_from: [],
        },
        confidence: 1,
        created_at: NOW,
        last_reinforced_at: NOW,
        expires_at: null,
        supersedes: [],
        superseded_by: [],
        scope: 'project',
        signals: {
          agrees_with: [],
          conflicts_with: [],
          validation_status: 'unchecked',
          last_validated_at: null,
        },
        principal_id: input.principal,
        taint: 'clean',
        metadata: {
          agent_session: {
            model_id: 'stub',
            adapter_id: 'stub-adapter',
            workspace_id: input.workspace.id,
            started_at: NOW,
            completed_at: NOW,
            terminal_state: 'completed',
            replay_tier: input.replayTier,
            budget_consumed: { turns: opts.outputs.length, wall_clock_ms: 0, usd: 0.5 },
          } satisfies AgentSessionMeta,
        },
      };
      await input.host.atoms.put(sessionAtom);
      const turnAtomIds: AtomId[] = [];
      for (let i = 0; i < opts.outputs.length; i++) {
        // Derive the turn id from sessionId (which already carries a
        // randomBytes suffix) rather than from correlationId alone. Two
        // adapter runs that share a correlationId would otherwise mint
        // colliding turn ids; deriving from sessionId isolates each run
        // even when callers reuse the correlation.
        const turnId = `${sessionId}-turn-${i}` as AtomId;
        const turnAtom: Atom = {
          schema_version: 1,
          id: turnId,
          content: `stub-turn-${i}`,
          type: 'agent-turn',
          layer: 'L0',
          provenance: {
            kind: 'agent-observed',
            source: {
              tool: 'stub',
              agent_id: String(input.principal),
              session_id: input.correlationId,
            },
            derived_from: [sessionId],
          },
          confidence: 1,
          created_at: NOW,
          last_reinforced_at: NOW,
          expires_at: null,
          supersedes: [],
          superseded_by: [],
          scope: 'project',
          signals: {
            agrees_with: [],
            conflicts_with: [],
            validation_status: 'unchecked',
            last_validated_at: null,
          },
          principal_id: input.principal,
          taint: 'clean',
          metadata: {
            agent_turn: {
              session_atom_id: sessionId,
              turn_index: i,
              // Canonical AgentTurnMeta discriminated-union shape:
              // small payloads ride inline; large payloads externalize
              // via BlobStore. Stubs default to inline because the
              // outputs are deterministic small JSON strings; tests
              // that need the {ref:BlobRef} branch use makeBlobRefStub.
              llm_input: { inline: '<stub-input>' },
              llm_output: { inline: opts.outputs[i]! },
              tool_calls: [],
              latency_ms: 100,
            } satisfies AgentTurnMeta,
          },
        };
        await input.host.atoms.put(turnAtom);
        turnAtomIds.push(turnId);
      }
      return {
        kind: 'completed',
        sessionAtomId: sessionId,
        turnAtomIds,
      };
    },
  };
}

/**
 * Build a substrate-host bundle for tests: a MemoryHost, a content-
 * addressed BlobStore, an identity Redactor, and a WorkspaceProvider
 * that returns deterministic Workspace objects without touching disk.
 *
 * Returns the bundle as a flat object so tests destructure only what
 * they need.
 */
export function makeStubHostBundle(): {
  host: ReturnType<typeof createMemoryHost>;
  blobStore: BlobStore;
  redactor: Redactor;
  workspaceProvider: WorkspaceProvider;
} {
  const host = createMemoryHost({
    canonInitial: '<!-- canon: managed -->\n[]\n',
  });
  // Backed by an in-memory Map keyed by the same string returned by
  // blobRefFromHash so put/get/has round-trip correctly. The previous
  // shape had get() return an empty Buffer and has() always return
  // true, which masked the readFinalOutputJson blob-deref bug behind a
  // false-success: any test asserting on round-trip behaviour had to
  // override the stub. With the in-memory backing tests can validate
  // the {ref:BlobRef} branch without bespoke overrides.
  const blobs = new Map<string, Buffer>();
  const blobStore: BlobStore = {
    async put(content) {
      const buf =
        typeof content === 'string' ? Buffer.from(content) : content;
      const ref = blobRefFromHash(
        createHash('sha256').update(buf).digest('hex'),
      );
      blobs.set(String(ref), buf);
      return ref;
    },
    async get(ref) {
      const buf = blobs.get(String(ref));
      if (buf === undefined) {
        throw new Error(`stub blobStore.get: unknown ref ${String(ref)}`);
      }
      return buf;
    },
    async has(ref) {
      return blobs.has(String(ref));
    },
    describeStorage() {
      return { kind: 'local-file' as const, rootPath: '/tmp/test' };
    },
  };
  const redactor: Redactor = {
    redact: (content) => content,
  };
  const workspaceProvider: WorkspaceProvider = {
    async acquire(input) {
      return {
        id: `ws-${input.correlationId}`,
        path: `/tmp/${input.correlationId}`,
        baseRef: input.baseRef,
      } satisfies Workspace;
    },
    async release() {},
  };
  return { host, blobStore, redactor, workspaceProvider };
}
