/**
 * layered-autonomous-governance public API.
 *
 * This is the top-level entry point. Host factories live on adapter
 * sub-paths to keep the top-level package free of heavyweight runtime
 * dependencies:
 *
 *   import { createMemoryHost } from 'layered-autonomous-governance/adapters/memory';
 *   import { createFileHost }   from 'layered-autonomous-governance/adapters/file';
 *   import { createBridgeHost }    from 'layered-autonomous-governance/adapters/bridge';
 *
 * Everything else (types, interfaces, core modules) imports cleanly
 * from the top-level:
 *
 *   import { LoopRunner, arbitrate, PromotionEngine, propagateCompromiseTaint } from 'layered-autonomous-governance';
 *   import type { Host, Atom, AtomId, PrincipalId } from 'layered-autonomous-governance';
 */

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------
export type {
  Action,
  Atom,
  AtomFilter,
  AtomId,
  AtomPage,
  AtomPatch,
  AtomSignals,
  AtomType,
  AuditEvent,
  AuditFilter,
  AuditId,
  AuditRefs,
  Commit,
  CommitRef,
  Diff,
  Disposition,
  Event,
  EventKind,
  JsonSchema,
  JudgeMetadata,
  JudgeResult,
  Layer,
  LlmOptions,
  NotificationHandle,
  PermittedLayers,
  PermittedScopes,
  PlanState,
  QuestionState,
  Principal,
  PrincipalId,
  Proposal,
  ProposalId,
  ProposalStatus,
  Provenance,
  ProvenanceKind,
  ProvenanceSource,
  RegistrationId,
  Scope,
  SearchHit,
  Severity,
  TaintState,
  Target,
  Time,
  ValidationStatus,
  Vector,
} from './types.js';

// ---------------------------------------------------------------------------
// Core interfaces
// ---------------------------------------------------------------------------
export type {
  AtomStore,
  Auditor,
  CanonStore,
  Clock,
  Embedder,
  Host,
  LLM,
  Notifier,
  PrincipalStore,
  Scheduler,
  SchedulerHandler,
  Transaction,
} from './interface.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export {
  ConflictError,
  HostError,
  NotFoundError,
  PermissionError,
  TimeoutError,
  TransientError,
  UnsupportedError,
  ValidationError,
} from './errors.js';

// ---------------------------------------------------------------------------
// Arbitration
// ---------------------------------------------------------------------------
export {
  applyDecision,
  arbitrate,
  DETECT_SCHEMA,
  DETECT_SYSTEM,
  sourceRank,
  ValidatorRegistry,
} from './arbitration/index.js';
export type {
  ArbiterOptions,
  ConflictPair,
  Decision,
  DecisionOutcome,
} from './arbitration/index.js';

// ---------------------------------------------------------------------------
// Kill switch (medium-tier runtime revocation)
// ---------------------------------------------------------------------------
export {
  createKillSwitch,
  isKillSwitchAbortReason,
} from './kill-switch/index.js';
export type {
  CreateKillSwitchOptions,
  KillSwitchAbortReason,
  KillSwitchController,
  KillSwitchTrigger,
} from './kill-switch/index.js';

// ---------------------------------------------------------------------------
// Per-principal LLM tool policy (resolves disallowedTools from canon)
// ---------------------------------------------------------------------------
export {
  LLM_TOOL_POLICY_PREFIX,
  LlmToolPolicyError,
  llmToolPolicyAtomId,
  loadLlmToolPolicy,
} from './llm-tool-policy.js';
export type { LlmToolPolicy } from './llm-tool-policy.js';

// ---------------------------------------------------------------------------
// Promotion
// ---------------------------------------------------------------------------
export {
  DEFAULT_THRESHOLDS,
  evaluate as evaluatePromotion,
  PromotionEngine,
  sourceLayerFor,
} from './promotion/index.js';
export type {
  LayerThresholds,
  PromotableLayer,
  PromotionCandidate,
  PromotionDecision,
  PromotionEngineOptions,
  PromotionOutcome,
  PromotionOutcomeKind,
  PromotionThresholds,
} from './promotion/index.js';

// ---------------------------------------------------------------------------
// Loop (decay + TTL + tick runner)
// ---------------------------------------------------------------------------
export {
  DEFAULT_HALF_LIVES,
  decayedConfidence,
  LoopRunner,
  shouldUpdateConfidence,
  ttlExpirePatch,
} from './loop/index.js';
export type {
  CanonTarget,
  HalfLifeConfig,
  LoopOptions,
  LoopStats,
  LoopTickReport,
  TtlExpireOptions,
} from './loop/index.js';

// ---------------------------------------------------------------------------
// Canon-md manager
// ---------------------------------------------------------------------------
export {
  CANON_END,
  CANON_START,
  CanonMdManager,
  extractSection,
  readFileOrEmpty,
  readSection,
  renderCanonMarkdown,
  replaceSection,
  writeSection,
} from './canon-md/index.js';
export type {
  CanonSectionWriteResult,
  RenderOptions,
} from './canon-md/index.js';

// ---------------------------------------------------------------------------
// Daemon (Phase 41): ambient Telegram runtime
// ---------------------------------------------------------------------------
export {
  LAGDaemon,
  splitForTelegram,
  invokeClaude,
  assembleContext,
} from './daemon/index.js';
export type {
  LAGDaemonOptions,
  InvokeClaudeOptions,
  InvokeClaudeResult,
  AssembleContextOptions,
  AssembledContext,
} from './daemon/index.js';

// ---------------------------------------------------------------------------
// Session sources (Phase 40): pluggable kick-off adapters
// ---------------------------------------------------------------------------
export {
  ClaudeCodeTranscriptSource,
  FreshSource,
  GitLogSource,
  ObsidianVaultSource,
  parseLine as parseClaudeCodeLine,
  parseGitLog,
  parseNote as parseObsidianNote,
  listMarkdownRecursive,
} from './sources/index.js';
export type {
  ClaudeCodeTranscriptSourceOptions,
  GitLogSourceOptions,
  IngestOptions,
  IngestReport,
  ObsidianVaultSourceOptions,
  SessionSource,
} from './sources/index.js';

// ---------------------------------------------------------------------------
// Extraction (Phase 43): L0 raw -> L1 structured claims via LLM judge
// ---------------------------------------------------------------------------
export {
  extractClaimsFromAtom,
  runExtractionPass,
} from './extraction/index.js';
export type {
  ExtractClaimsOptions,
  ExtractionPassOptions,
  ExtractionReport,
  ExtractionPassReport,
} from './extraction/index.js';

// ---------------------------------------------------------------------------
// Policy (Phase 52a): canon-driven autonomy dial above Claude's permission mode
// ---------------------------------------------------------------------------
export {
  checkToolPolicy,
  matchSpecificity,
  parsePolicy,
} from './policy/index.js';
export type {
  PolicyContext,
  PolicyDecision,
  PolicyResult,
} from './policy/index.js';

// ---------------------------------------------------------------------------
// Questions (Phase 50b): HIL Q-A with causality binding
// ---------------------------------------------------------------------------
export {
  askQuestion,
  bindAnswer,
  canTransitionQuestion,
  expirePastDueQuestions,
  InvalidQuestionTransitionError,
  listPendingQuestions,
} from './questions/index.js';
export type {
  AskQuestionOptions,
  BindAnswerOptions,
  BindAnswerResult,
} from './questions/index.js';

// ---------------------------------------------------------------------------
// Plans (Phase 38): intent governance
// ---------------------------------------------------------------------------
export {
  canTransition,
  executePlan,
  InvalidPlanTransitionError,
  summarizeValidation,
  transitionPlanState,
  validatePlan,
} from './plans/index.js';
export type {
  ExecutePlanOptions,
  ExecutionOutcomeAtom,
  ExecutionReport,
  ExecutionResult,
  PlanConflict,
  PlanValidationResult,
  PlanValidationStatus,
  ValidatePlanOptions,
} from './plans/index.js';

// ---------------------------------------------------------------------------
// Taint
// ---------------------------------------------------------------------------
export {
  propagateCompromiseTaint,
} from './taint/index.js';
export type {
  PropagateOptions,
  TaintReport,
} from './taint/index.js';

// ---------------------------------------------------------------------------
// Judge schemas
// ---------------------------------------------------------------------------
export {
  CLASSIFY_ATOM,
  DETECT_ANOMALY,
  DETECT_CONFLICT,
  EXTRACT_CLAIMS,
  getSchema,
  JUDGE_SCHEMAS,
  SUMMARIZE_DIGEST,
  VALIDATE_CLAIM,
} from './schemas/index.js';
export type {
  ClassifyAtomOutput,
  DetectAnomalyOutput,
  DetectConflictOutput,
  ExtractClaimsOutput,
  JudgeSchemaId,
  JudgeSchemaSet,
  SummarizeDigestOutput,
  ValidateClaimOutput,
} from './schemas/index.js';

// ---------------------------------------------------------------------------
// Embedders (adapter-agnostic)
// ---------------------------------------------------------------------------
export { TrigramEmbedder } from './adapters/_common/trigram-embedder.js';
export { CachingEmbedder, cacheDirFor } from './adapters/_common/caching-embedder.js';
export type { CachingEmbedderOptions } from './adapters/_common/caching-embedder.js';
// OnnxMiniLmEmbedder pulls in @huggingface/transformers and a ~90MB model
// at instantiation time (not import time). Safe to re-export here.
export {
  OnnxMiniLmEmbedder,
} from './adapters/_common/onnx-minilm-embedder.js';
export type {
  OnnxMiniLmOptions,
} from './adapters/_common/onnx-minilm-embedder.js';
