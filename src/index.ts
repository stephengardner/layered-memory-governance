/**
 * layered-autonomous-governance - public API.
 *
 * This is the substrate barrel. Everything exported here is
 * load-bearing for any LAG deployment regardless of orchestration
 * strategy: atoms, principals, arbitration, promotion, taint,
 * canon, kill-switch, policy.
 *
 * Runtime primitives, adapters, integrations, ingestion sources,
 * retrieval stack, LLM-judge schemas, and the CLI live on their
 * own subpaths. This keeps the top-level import surface narrow and
 * makes the substrate-vs-rest split visible from the import path
 * alone:
 *
 *   import { arbitrate, createKillSwitch, checkToolPolicy } from 'layered-autonomous-governance';
 *   import { LoopRunner }             from 'layered-autonomous-governance/runtime';
 *   import { runActor }               from 'layered-autonomous-governance/runtime/actors';
 *   import { withLagGovernance }      from 'layered-autonomous-governance/integrations/langgraph';
 *   import { createMemoryHost }       from 'layered-autonomous-governance/adapters/memory';
 *   import { invokeClaude }           from 'layered-autonomous-governance/adapters/llm/claude-cli';
 *   import { TrigramEmbedder }        from 'layered-autonomous-governance/retrieval';
 *   import { ClaudeCodeTranscriptSource } from 'layered-autonomous-governance/ingestion';
 *   import { DETECT_CONFLICT }        from 'layered-autonomous-governance/llm-judge';
 */

export * from './substrate/index.js';
