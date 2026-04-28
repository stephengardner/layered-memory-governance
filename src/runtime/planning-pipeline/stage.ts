/**
 * PlanningStage interface re-export. Stage adapters import from this
 * module so the canonical surface stays one path even if the type
 * implementation moves.
 */

export type {
  PlanningStage,
  StageInput,
  StageOutput,
  StageContext,
  AuditFinding,
  RetryStrategy,
} from './types.js';
