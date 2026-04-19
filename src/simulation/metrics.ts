import type { RunResult } from './types.js';

export interface Summary {
  readonly name: string;
  readonly ticks: number;
  readonly atomsWritten: number;
  readonly atomsSuperseded: number;
  readonly checkpointAccuracy: number;
  readonly supersessionAccuracy: number;
  readonly allPassed: boolean;
}

export function summarize(result: RunResult): Summary {
  const cpAcc = result.checkpointsTotal === 0
    ? 1
    : result.checkpointsPassed / result.checkpointsTotal;
  const ssAcc = result.supersessionsTotal === 0
    ? 1
    : result.supersessionsPassed / result.supersessionsTotal;
  return {
    name: result.scenarioName,
    ticks: result.ticksProcessed,
    atomsWritten: result.atomsWritten,
    atomsSuperseded: result.atomsSuperseded,
    checkpointAccuracy: cpAcc,
    supersessionAccuracy: ssAcc,
    allPassed:
      result.checkpointsPassed === result.checkpointsTotal &&
      result.supersessionsPassed === result.supersessionsTotal,
  };
}

export function formatReport(result: RunResult): string {
  const s = summarize(result);
  const lines: string[] = [];
  lines.push(`Scenario: ${s.name}`);
  lines.push(`Ticks processed: ${s.ticks}`);
  lines.push(`Atoms written: ${s.atomsWritten} (${s.atomsSuperseded} superseded)`);
  lines.push(
    `Checkpoints: ${result.checkpointsPassed}/${result.checkpointsTotal} (${(s.checkpointAccuracy * 100).toFixed(1)}%)`,
  );
  lines.push(
    `Supersessions: ${result.supersessionsPassed}/${result.supersessionsTotal} (${(s.supersessionAccuracy * 100).toFixed(1)}%)`,
  );
  lines.push(`All passed: ${s.allPassed}`);
  if (result.checkpointResults.some(r => !r.passed)) {
    lines.push('');
    lines.push('Failing checkpoints:');
    for (const cp of result.checkpointResults) {
      if (cp.passed) continue;
      lines.push(
        `  tick ${cp.atTick} "${cp.query}" -> expected ${cp.expectedLabel}, got ${cp.actualTopHitContent?.slice(0, 60) ?? '(no hit)'}`,
      );
    }
  }
  if (result.supersessionResults.some(r => !r.passed)) {
    lines.push('');
    lines.push('Failing supersession checks:');
    for (const ss of result.supersessionResults) {
      if (ss.passed) continue;
      lines.push(`  ${ss.label} <- ${ss.shouldBeSupersededBy}: ${ss.reason ?? 'unknown'}`);
    }
  }
  return lines.join('\n');
}
