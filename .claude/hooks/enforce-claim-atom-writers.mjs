#!/usr/bin/env node
/**
 * PreToolUse hook: enforce substrate-only writes of claim-lifecycle
 * atoms.
 *
 * Why: the claim-contract substrate mints four lifecycle atom types
 * (`claim-attestation-accepted`, `claim-attestation-rejected`,
 * `claim-stalled`, `claim-escalated`) that record terminal outcomes
 * of a dispatched sub-agent's work claim. The substrate's contract
 * module writes these under the `apex-agent` principal so the audit
 * trail is unforgeable from inside a sub-agent's tool-loop. A
 * sub-agent that bypasses the contract and writes one of these atoms
 * directly produces a forged terminal record (e.g. a `code-author`
 * minting its own `claim-attestation-accepted` to mark a failed PR
 * as merged-successful). This hook is the mechanical gate that
 * rejects every direct sub-agent write at PreToolUse time.
 *
 * Threat model (spec Section 11 row 11):
 *   - Routine sub-agent bypass: a buggy or malicious sub-agent
 *     principal calls AtomStore.put with a claim-lifecycle type and
 *     its own principal_id. THIS HOOK BLOCKS IT.
 *   - In-process forgery from a compromised contract module:
 *     out-of-scope for this hook; mitigated by STOP sentinel +
 *     medium-tier kill switch.
 *   - Self-attributed forgery (a sub-agent setting
 *     `atom.principal_id = 'apex-agent'` on its own write): the
 *     PreToolUse hook payload exposes ONLY `tool_input`, which the
 *     calling agent controls. There is no authenticated caller
 *     channel at the hook layer today. The hook is one defence
 *     layer; the authoritative gate is the claim-contract module
 *     itself (`markClaimComplete` validates the
 *     `claim_secret_token` constant-time so a forged write that
 *     lacks the token cannot legitimately enter the lifecycle).
 *     The substrate's PROVENANCE chain (every claim-lifecycle atom
 *     is derived_from the claim atom written through `dispatchSubAgent`)
 *     surfaces the bypass to audit projections even if the hook is
 *     defeated.
 *
 * Allowlist: ONLY `apex-agent` may write the four claim-lifecycle
 * atom types. Any other principal (cto-actor, code-author,
 * pr-fix-actor, cpo-actor, brainstorm-actor, spec-author, plan-author,
 * pipeline-auditor, plan-dispatcher, or any future principal) is
 * denied. The denial is default-on for principal_id values the hook
 * does not recognise, per `inv-governance-before-autonomy`: adding a
 * new substrate writer is a conscious canon edit that broadens this
 * allowlist, not a config knob.
 *
 * Mechanism (Claude Code PreToolUse protocol):
 *   - Receives JSON on stdin: { tool_name, tool_input, ... }
 *   - For AtomStore-write tool calls whose atom.type is in the
 *     claim-lifecycle denial set AND whose atom.principal_id is not
 *     `apex-agent`, emits {"decision":"block","reason":"..."} on
 *     stdout AND prints the diagnostic to stderr so the bypass is
 *     visible in the operator's session log.
 *   - Everything else: exit 0 silently.
 *
 * Atom-write tool surfaces inspected:
 *   - `AtomStore.put`        (canonical in-process form)
 *   - `mcp__atomstore__put`  (future MCP variant, reserved)
 *   - Future names matching `AtomStore.<verb>` or
 *     `mcp__atomstore__<verb>` are inspected on the same shape so a
 *     new write surface does not silently bypass the hook.
 *
 * Scope: only this repo. The hook file lives under `.claude/` which
 * is repo-local. In any other project the hook does not exist and
 * the rule does not apply.
 *
 * Fail-open: any unexpected input / parse failure / shape mismatch
 * allows the tool call. The hook never wedges a session; downstream
 * validation in the contract module is the second line of defence
 * for malformed atoms.
 */

const CLAIM_LIFECYCLE_TYPES = new Set([
  'claim-attestation-accepted',
  'claim-attestation-rejected',
  'claim-stalled',
  'claim-escalated',
]);

const SUBSTRATE_PRINCIPAL = 'apex-agent';

// Tool names that route to an atom-store write. The set is small and
// explicit today; future write verbs (replace, transition) on either
// the in-process or MCP form are inspected by the prefix tests below
// so a new entry-point cannot silently bypass the hook.
function isAtomStoreWriteTool(toolName) {
  if (typeof toolName !== 'string') return false;
  // Canonical in-process forms: `AtomStore.put`, `AtomStore.replace`,
  // `AtomStore.transition`, etc. Case-sensitive on `AtomStore` so a
  // genuine collision with an unrelated `atomstore` symbol stays out
  // of scope.
  if (toolName.startsWith('AtomStore.')) return true;
  // MCP form: `mcp__atomstore__put`, `mcp__atomstore__replace`, etc.
  if (toolName.startsWith('mcp__atomstore__')) return true;
  return false;
}

async function main() {
  let payload;
  try {
    const raw = await readStdin();
    payload = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    // Malformed payload: fail-open per the hook's documented
    // contract. Downstream validation will catch genuinely bad
    // shapes.
    process.exit(0);
  }

  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  if (!isAtomStoreWriteTool(toolName)) process.exit(0);

  // Two-step decode so we can distinguish "no tool_input at all"
  // (the call is shape-ambiguous; allow and let downstream validation
  // handle it) from "tool_input present but atom field missing"
  // (definite atom-store write surface with no payload; deny because
  // that is the alternate-write-shape bypass surface CR flagged).
  const toolInput = payload.tool_input;
  if (toolInput === undefined || toolInput === null) {
    // The toolName matched isAtomStoreWriteTool but the payload has
    // no tool_input. We have no surface to inspect; fall open and
    // let downstream validation handle the shape error. Tightening
    // this rung further is a future change once the substrate's
    // hook payload exposes an authenticated caller channel.
    process.exit(0);
  }
  const atom = toolInput.atom;
  if (atom === undefined || atom === null || typeof atom !== 'object') {
    // tool_input is present but `atom` is absent or non-object. This
    // is the alternate-write-shape vector the hook must close; deny.
    blockMalformed('atom payload missing or not an object');
    return;
  }

  const atomType = typeof atom.type === 'string' ? atom.type : '';
  if (atomType === '' || !CLAIM_LIFECYCLE_TYPES.has(atomType)) {
    // Not a claim-lifecycle atom; out of scope for this hook.
    process.exit(0);
  }

  // From here, the atom IS a claim-lifecycle type. The only allowed
  // principal is the substrate principal.
  const principalId = typeof atom.principal_id === 'string' ? atom.principal_id : '';
  if (principalId === '') {
    // Claim-lifecycle write with no principal_id is unauthorizable.
    // Deny rather than fail-open; the substrate writer ALWAYS sets
    // principal_id, so a missing value is a shape error AND a bypass
    // vector. Letting it through would mint a claim-lifecycle atom
    // outside the allowlist semantics.
    blockMalformed('claim-lifecycle atom missing principal_id');
    return;
  }

  if (principalId === SUBSTRATE_PRINCIPAL) {
    // The sanctioned write path. Allow.
    process.exit(0);
  }

  // Block: a non-substrate principal is attempting to mint a
  // claim-lifecycle atom. Emit both the JSON decision and a stderr
  // diagnostic so the operator session log captures the bypass even
  // if the agent surfaces only one of the two channels.
  const reason = [
    `claim-lifecycle atom write blocked by .claude/hooks/enforce-claim-atom-writers.mjs.`,
    ``,
    `The substrate's claim-contract module mints claim-attestation-accepted,`,
    `claim-attestation-rejected, claim-stalled, and claim-escalated atoms`,
    `under the apex-agent principal so the audit trail is unforgeable from`,
    `inside any sub-agent's tool-loop. Any other principal attempting to`,
    `write one of these atoms directly is a bypass attempt.`,
    ``,
    `    OFFENDING PRINCIPAL: ${principalId}`,
    `    OFFENDING ATOM TYPE: ${atomType}`,
    ``,
    `If this is a substrate-side write that legitimately needs a new`,
    `allowed principal (e.g. a future co-substrate process), widen the`,
    `allowlist via a deliberate canon edit and update this hook in the`,
    `same change. Adding a writer is a conscious authority broadening,`,
    `not a config knob.`,
    ``,
    `Per spec Section 11 row 11 this hook is the primary gate against`,
    `routine sub-agent bypass; in-process forgery from a compromised`,
    `substrate module is out of scope (mitigated by STOP sentinel +`,
    `medium-tier kill switch).`,
  ].join('\n');

  process.stderr.write(`${reason}\n`);
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

/**
 * Emit a block decision with a short malformed-shape reason and exit.
 * Used when the hook matched an atom-store write surface but cannot
 * authenticate the payload. Deny is the correct posture: the alternative
 * (fail-open) leaves an escape hatch for malformed lifecycle writes to
 * bypass the gate entirely.
 */
function blockMalformed(why) {
  const reason = [
    `claim-lifecycle atom write blocked by .claude/hooks/enforce-claim-atom-writers.mjs.`,
    ``,
    `Reason: ${why}.`,
    ``,
    `The substrate's claim-contract module ALWAYS sends a typed atom`,
    `payload with a principal_id field. A write that reaches this hook`,
    `without those fields is either a malformed sub-agent attempt or an`,
    `alternate write shape that the hook cannot authenticate. Deny is`,
    `the correct posture; allow would leave the gate open for the exact`,
    `bypass it exists to close.`,
  ].join('\n');
  process.stderr.write(`${reason}\n`);
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

main().catch(() => process.exit(0));
