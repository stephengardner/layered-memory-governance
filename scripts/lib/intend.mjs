// scripts/lib/intend.mjs - pure helpers for scripts/intend.mjs.
// Zero imports from src/, dist/, .lag/.

const SCOPE_VALUES = ['tooling', 'docs', 'framework', 'canon'];
const BLAST_RADIUS_VALUES = ['none', 'docs', 'tooling', 'framework', 'l3-canon-proposal'];
const SUB_ACTORS = ['code-author', 'auditor-actor'];

export function parseIntendArgs(argv) {
  const args = {
    request: null,
    scope: null,
    blastRadius: null,
    subActors: null,
    minConfidence: 0.75,
    expiresIn: undefined,
    kind: 'autonomous-solve',
    dryRun: false,
    trigger: false,
    invokersPath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--request' && i + 1 < argv.length) { args.request = argv[++i]; }
    else if (a === '--scope' && i + 1 < argv.length) { args.scope = argv[++i]; }
    else if (a === '--blast-radius' && i + 1 < argv.length) { args.blastRadius = argv[++i]; }
    else if (a === '--sub-actors' && i + 1 < argv.length) { args.subActors = argv[++i].split(',').map(s => s.trim()).filter(Boolean); }
    else if (a === '--min-confidence' && i + 1 < argv.length) { args.minConfidence = Number(argv[++i]); }
    else if (a === '--expires-in' && i + 1 < argv.length) { args.expiresIn = argv[++i]; }
    else if (a === '--kind' && i + 1 < argv.length) { args.kind = argv[++i]; }
    else if (a === '--dry-run') { args.dryRun = true; }
    else if (a === '--trigger') { args.trigger = true; }
    else if (a === '--invokers' && i + 1 < argv.length) { args.invokersPath = argv[++i]; }
    else { return { ok: false, reason: `unknown or misplaced argument: ${a}` }; }
  }
  if (!args.request) return { ok: false, reason: '--request is required' };
  if (!args.scope) return { ok: false, reason: '--scope is required' };
  if (!SCOPE_VALUES.includes(args.scope)) return { ok: false, reason: `--scope must be one of ${SCOPE_VALUES.join(',')}` };
  if (!args.blastRadius) return { ok: false, reason: '--blast-radius is required' };
  if (!BLAST_RADIUS_VALUES.includes(args.blastRadius)) return { ok: false, reason: `--blast-radius must be one of ${BLAST_RADIUS_VALUES.join(',')}` };
  if (!args.subActors || args.subActors.length === 0) return { ok: false, reason: '--sub-actors is required' };
  for (const s of args.subActors) {
    if (!SUB_ACTORS.includes(s)) return { ok: false, reason: `sub-actor ${s} not in v1 allowlist ${SUB_ACTORS.join(',')}` };
  }
  if (!Number.isFinite(args.minConfidence) || args.minConfidence < 0 || args.minConfidence > 1) {
    return { ok: false, reason: '--min-confidence must be a number in [0,1]' };
  }
  return { ok: true, args };
}

const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;
const MAX_EXPIRES_HOURS = 72;

export function computeExpiresAt(raw, now) {
  if (raw === undefined || raw === null) {
    return new Date(now.getTime() + 24 * HOUR_MS).toISOString();
  }
  const m = /^(\d+)([hm])$/.exec(raw);
  if (!m) throw new Error(`invalid --expires-in format: ${raw} (expected Nh or Nm)`);
  const n = Number(m[1]);
  const unit = m[2];
  const totalMs = unit === 'h' ? n * HOUR_MS : n * MIN_MS;
  if (totalMs > MAX_EXPIRES_HOURS * HOUR_MS) {
    throw new Error(`--expires-in exceeds safety cap of ${MAX_EXPIRES_HOURS}h`);
  }
  return new Date(now.getTime() + totalMs).toISOString();
}

function requireNonEmptyString(name, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`buildCtoSpawnArgs: ${name} is required`);
  }
}

/**
 * Build the argv array intend.mjs --trigger spawns onto run-cto-actor.mjs.
 * Pinning this here (rather than inline in scripts/intend.mjs) lets a
 * regression test assert that --invokers is always present for the
 * trigger path; without it the deep planning pipeline succeeds through
 * brainstorm/spec/plan/review and only fails-loud at dispatch-stage
 * with "principal code-author is not registered". Operators with a
 * deployment-specific invokers module pass --invokers <override-path>
 * to intend.mjs (parsed there + threaded into invokersPath here); the
 * caller seeds the indie-floor default when the operator did not pass
 * one, so the zero-config `intend.mjs --request "..." --trigger` flow
 * works end-to-end.
 */
export function buildCtoSpawnArgs(spec) {
  const { runCtoActorPath, request, atomId, invokersPath } = spec;
  requireNonEmptyString('runCtoActorPath', runCtoActorPath);
  requireNonEmptyString('request', request);
  requireNonEmptyString('atomId', atomId);
  requireNonEmptyString('invokersPath', invokersPath);
  return [
    runCtoActorPath,
    '--request', request,
    '--intent-id', atomId,
    '--invokers', invokersPath,
  ];
}

/**
 * POSIX shell-quote a single argv token for paste-safe rendering of
 * `intend --no-trigger`'s manual fallback command. Wraps with single
 * quotes and escapes any embedded single quote via the standard
 * `'\''` close-reopen idiom; that handles every other special
 * character (whitespace, `$`, backticks, backslashes, double quotes,
 * `&`, `;`, glob metacharacters) without further escaping. A token
 * containing only safe characters skips the wrapping for readability.
 */
export function shellQuote(token) {
  if (typeof token !== 'string') {
    throw new Error('shellQuote: token must be a string');
  }
  if (token.length === 0) return "''";
  // Only chars that need no quoting in a posix shell argv position.
  if (/^[A-Za-z0-9_\-+.,/:=@%]+$/.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

export function buildIntentAtom(spec) {
  const {
    request, scope, blastRadius, subActors, minConfidence,
    expiresAt, operatorPrincipalId, now, nonce,
  } = spec;
  const createdAt = now.toISOString();
  const idCore = `intent-${nonce}-${createdAt.replace(/[:.]/g, '-')}`;
  return {
    schema_version: 1,
    id: idCore,
    type: 'operator-intent',
    layer: 'L1',
    principal_id: operatorPrincipalId,
    provenance: {
      kind: 'operator-seeded',
      source: { tool: 'intend-cli' },
      derived_from: [],
    },
    confidence: 1,
    scope,
    content: request,
    metadata: {
      kind: 'autonomous-solve',
      request,
      trust_envelope: {
        max_blast_radius: blastRadius,
        max_plans: 5,
        min_plan_confidence: minConfidence,
        allowed_sub_actors: subActors,
        require_ci_green: true,
        require_cr_approve: true,
        require_auditor_observation: true,
      },
      expires_at: expiresAt,
      consumed_by_plans: [],
      consumed_by_questions: [],
    },
    created_at: createdAt,
    last_reinforced_at: createdAt,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    taint: 'clean',
    signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
  };
}
