# Vendored skill bundles for agentic pipeline stages

Each `<skill>.md` here is the substrate-canonical content the
`runStageAgentLoop` helper embeds into the agent's prompt for the
matching pipeline stage. The `skill-bundle-resolver.ts` tries the
operator's local plugin cache first
(`~/.claude/plugins/cache/claude-plugins-official/superpowers/<version>/skills/<bundle>/SKILL.md`)
and falls back to the vendored copy here when the cache is absent.

These vendored copies are tuned for agent-loop consumption:
- Trimmed to the discipline + checklist the in-stage agent needs.
- No human-side ceremony (no "ask the user" gates; the pipeline IS
  the user from the agent's perspective).
- Focused on the stage's deliverable shape so the schema-validate step
  in the helper does not produce false-fail emissions.

To refresh from upstream:
1. Read the canonical SKILL.md from the operator's plugin cache.
2. Adapt the human-facing language to the agent-loop scope (no "ask
  questions one at a time" since the agent has no human session).
3. Save the adapted content here.
4. Commit.

The vendored versions are normative; the plugin cache is the
forward-compat path.
