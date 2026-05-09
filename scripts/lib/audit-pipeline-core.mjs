// Pure helpers for scripts/audit-pipeline.mjs. Extracted into their
// own shebang-free module so vitest can static-import them from a
// .test.ts file. Vitest's default include pattern matches *.test.ts
// only; importing a shebanged .mjs from a .ts test causes SyntaxError
// at line 1 column 1 even though Node's own loader handles it fine
// when the file is invoked directly. The bin entrypoint at
// scripts/audit-pipeline.mjs re-exports from this module and adds
// the shebang + adapter wiring.
//
// No I/O, no host construction, no spawn. The auditPipeline function
// takes an adapter (with a `query({atom_type, pipeline_id})` method)
// and the pipeline id, returning a structured {exitCode, stdout,
// stderr} result. The bin layer wires a real Host into this contract.

const STAGE_TYPES = [
  'operator-intent',
  'brainstorm-output',
  'spec-output',
  'plan-output',
  'review-output',
  'dispatch-output',
];

export { STAGE_TYPES };

function renderTree(pipelineId, stages) {
  let out = `${pipelineId}\n`;
  for (let i = 0; i < STAGE_TYPES.length; i++) {
    const atomType = STAGE_TYPES[i];
    const lastStage = i === STAGE_TYPES.length - 1;
    const stageBranch = lastStage ? '└── ' : '├── ';
    const leafIndent = lastStage ? '    ' : '│   ';
    const matches = stages[atomType];
    if (matches.length === 0) {
      out += `${stageBranch}${atomType} (empty)\n`;
      continue;
    }
    out += `${stageBranch}${atomType}\n`;
    for (let j = 0; j < matches.length; j++) {
      const lastLeaf = j === matches.length - 1;
      const leafBranch = lastLeaf ? '└── ' : '├── ';
      const m = matches[j];
      out += `${leafIndent}${leafBranch}${m.atom_id}  ${m.timestamp}  ${m.atom_type}\n`;
    }
  }
  return out;
}

export async function auditPipeline({ adapter, pipelineId }) {
  const stages = {};
  let total = 0;
  for (const atomType of STAGE_TYPES) {
    const rows = await adapter.query({ atom_type: atomType, pipeline_id: pipelineId });
    rows.sort((a, b) => {
      const ta = a.timestamp ?? '';
      const tb = b.timestamp ?? '';
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    stages[atomType] = rows;
    total += rows.length;
  }
  if (total === 0) {
    return { exitCode: 0, stdout: `No atoms found for pipeline-id ${pipelineId}\n`, stderr: '' };
  }
  return { exitCode: 0, stdout: renderTree(pipelineId, stages), stderr: '' };
}
