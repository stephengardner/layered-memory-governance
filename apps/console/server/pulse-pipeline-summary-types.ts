/**
 * Wire-shape definitions for the pulse pipeline-state summary surface.
 *
 * The Pulse dashboard needs an at-a-glance answer to "what is the
 * autonomous loop doing right now?" -- specifically:
 *   - how many pipelines are running RIGHT NOW (running + pending)
 *   - how many have dispatched a PR that is open and awaiting merge
 *   - how many have fulfilled the operator-intent (merged PR)
 *
 * Server-side aggregation is the only sane shape for this surface per
 * canon `dev-indie-floor-org-ceiling`: at 50+ concurrent actors a
 * client-side reduction would have to ship every pipeline atom on each
 * 2s tile refresh, vs three pre-rolled numbers plus a small sample.
 *
 * Read-only contract: every field is derived from atoms on disk
 * (pipeline + dispatch-record + pr-observation + plan-merge-settled),
 * stitched via the same `buildIntentOutcome` synthesizer the
 * /pipelines/<id> view already uses. Sharing the synthesizer keeps the
 * "intent-fulfilled" definition identical across surfaces -- a pipeline
 * that paints fulfilled in the detail view paints fulfilled in this
 * tile, by construction.
 */

/**
 * One small row in the pulse pipeline-summary samples. Mirrors the
 * shape that `PipelineLiveOpsRow` uses for the existing pipelines-in-
 * flight tile but is intentionally smaller because the Pulse tile only
 * surfaces a peek (most-recent N per bucket) -- the operator clicks
 * through to /pipelines for the full row.
 */
export interface PulsePipelineSummaryRow {
  readonly pipeline_id: string;
  /**
   * Pipeline title for the row label. Derived from the pipeline atom's
   * metadata.title, or the seed operator-intent atom's content, with a
   * fallback to the pipeline atom's id when neither resolves. The
   * synthesizer caps this at 240 chars so a verbose seed can't blow
   * the tile open.
   */
  readonly title: string;
  /**
   * Timestamp the row was last touched (latest event or merge), in ISO
   * UTC. Used for "X ago" rendering on the tile.
   */
  readonly last_event_at: string;
}

/**
 * The pulse pipeline-summary payload. Three counts + three small
 * sample arrays (most recent N per bucket). The tile renders the
 * counts as headline numbers and a thin sample list under each so the
 * operator can scan the active set without leaving the dashboard.
 */
export interface PulsePipelineSummary {
  /**
   * ISO UTC timestamp the summary was computed. Echoed back so the tile
   * can render a "computed at HH:MM:SS" line that updates each tick.
   */
  readonly computed_at: string;
  /**
   * Pipelines whose `pipeline_state` is `pending` or `running`. These
   * are actively in flight RIGHT NOW. The count is the headline number.
   */
  readonly running: number;
  /**
   * Pipelines that have dispatched a PR that is still open (not yet
   * merged or closed-unmerged). Reads from the same intent-outcome
   * synthesizer used on /pipelines/<id> so the "pending review"
   * definition is identical across surfaces.
   */
  readonly dispatched_pending_merge: number;
  /**
   * Pipelines whose operator-intent has been fulfilled (merged PR
   * observed). Reads from the same intent-outcome synthesizer; the
   * synthesizer's TRUE-outcome semantics require an OBSERVED merged
   * PR, not a plan_state alone.
   */
  readonly intent_fulfilled: number;
  /**
   * Total pipeline count across the live atom store (after the
   * isCleanLive filter). Helpful context for "X of N pipelines are
   * active" framing.
   */
  readonly total: number;
  /**
   * Up to MAX_PULSE_SAMPLE most-recent rows per bucket. Sorted by
   * last_event_at desc so the tile can paint the freshest activity
   * first. Always present (possibly empty) so the client renders the
   * sample list defensively without null guards.
   */
  readonly samples: {
    readonly running: ReadonlyArray<PulsePipelineSummaryRow>;
    readonly dispatched_pending_merge: ReadonlyArray<PulsePipelineSummaryRow>;
    readonly intent_fulfilled: ReadonlyArray<PulsePipelineSummaryRow>;
  };
}
