/**
 * Pure prompt assembler. Composes the user-facing prompt from the
 * substrate's `AgentTask` shape. Output is deterministic (same input
 * -> same string) so it can be content-hashed for replay.
 */

import type { AgentTask } from '../../../src/substrate/agent-loop.js';

export function buildPromptText(task: AgentTask): string {
  const parts: string[] = [];
  if (typeof task.questionPrompt === 'string' && task.questionPrompt.length > 0) {
    parts.push(task.questionPrompt);
  }
  if (task.fileContents !== undefined && task.fileContents.length > 0) {
    for (const fc of task.fileContents) {
      parts.push(`<file_contents path="${escapeAttribute(fc.path)}">\n${fc.content}\n</file_contents>`);
    }
  }
  if (typeof task.successCriteria === 'string' && task.successCriteria.length > 0) {
    parts.push(`<success_criteria>${task.successCriteria}</success_criteria>`);
  }
  if (task.targetPaths !== undefined && task.targetPaths.length > 0) {
    parts.push(`<target_paths>${task.targetPaths.join(', ')}</target_paths>`);
  }
  return parts.join('\n\n');
}

function escapeAttribute(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
