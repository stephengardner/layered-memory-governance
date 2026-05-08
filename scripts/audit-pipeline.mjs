#!/usr/bin/env node
// Stage list hardcoded for v1; future: lift from canon at
// pol-planning-pipeline-stages-default.
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STAGE_TYPES = [
  'operator-intent',
  'brainstorm-output',
  'spec-output',
  'plan-output',
  'review-output',
  'dispatch-output',
];

const USAGE = `Usage: lag-audit-pipeline --pipeline-id <id>

Walk the file adapter for <id> and print a tree of the six pipeline
stage atoms with atom_id, timestamp, and atom_type per leaf.

Options:
  --pipeline-id <id>   Pipeline id to audit (required)
  -h, --help           Show this help
`;

function parseArgs(argv) {
  const out = { pipelineId: null, help: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      out.help = true;
    } else if (a === '--pipeline-id') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        out.error = 'Missing value for --pipeline-id';
        return out;
      }
      out.pipelineId = v;
      i++;
    } else {
      out.error = `Unknown argument: ${a}`;
      return out;
    }
  }
  return out;
}

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

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.error) {
    process.stderr.write(`${args.error}\n\n${USAGE}`);
    return 2;
  }
  if (!args.pipelineId) {
    process.stderr.write(`Missing required --pipeline-id\n\n${USAGE}`);
    return 2;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const adapterUrl = pathToFileURL(resolve(here, '..', 'dist', 'adapters', 'file', 'index.js')).href;
  const mod = await import(adapterUrl);
  const adapter =
    typeof mod.createFileAdapter === 'function'
      ? mod.createFileAdapter()
      : typeof mod.default === 'function'
        ? mod.default()
        : new mod.FileAdapter();
  const result = await auditPipeline({ adapter, pipelineId: args.pipelineId });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.exitCode;
}

const invokedAsBin = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsBin) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err?.stack || err}\n`);
      process.exit(1);
    },
  );
