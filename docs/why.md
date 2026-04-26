# Why LAG exists

Once memory lives longer than a single session and spans more than one agent, it rots. Three named failure modes:

1. **Stale decisions.** A decision made last month does not surface this week. Retrieval returns similar text, not the authoritative version. The decision gets re-litigated.
2. **Unmarked reversals.** Someone changed their mind. The old opinion still surfaces three months later, as confidently as the new one, because nothing marked it superseded.
3. **Silent poison.** A hallucination or a write from a compromised agent reinforces itself via later turns. By the time anyone notices, the lineage is tangled and the clean-up is manual.

These are governance problems, not retrieval problems. Any vector store can return similar text. The hard part is knowing which memory is still true, who said it, what supersedes what, what to do when two sources disagree, and what to do when one of them turns out to have been compromised.

LAG treats memory as a governed substrate: every stored unit is an atom with provenance, confidence, layer, principal, and scope, and a deterministic rule stack resolves conflicts at write time before either side reaches retrieval.

If retrieval makes one agent smarter, governance keeps a hundred agents coherent. That is what LAG ships.

## Where this lands in canon

The reasons above are encoded as L3 atoms in this repo's own `.lag/` substrate, rendered into [`CLAUDE.md`](../CLAUDE.md). Read [`docs/canon.md`](canon.md) for the canon catalogue.
