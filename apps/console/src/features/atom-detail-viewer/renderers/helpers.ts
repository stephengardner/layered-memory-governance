/**
 * Pure helpers shared across type-specific atom-detail renderers.
 *
 * Why a helpers module instead of inline duplication: at N=2 callers
 * we extract per canon `dev-extract-at-n-equals-two`. Several
 * renderers narrow `metadata: Record<string, unknown>` into typed
 * shapes; the narrowing lives here so a metadata-shape rename hits
 * one file, not seven.
 *
 * Every helper is a pure function and side-effect free; renderers stay
 * declarative.
 */

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function asStringArray(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

export function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
}

/**
 * Many `*-output` atoms wrap their stage output as a JSON-encoded
 * string in `content` AND mirror it as a structured object on
 * `metadata.stage_output`. Renderers prefer the structured form when
 * present; this helper picks the right source.
 */
export function readStageOutput(
  metadata: Readonly<Record<string, unknown>> | undefined,
  content: string,
): Readonly<Record<string, unknown>> | null {
  if (metadata) {
    const direct = metadata['stage_output'];
    const asObj = asRecord(direct);
    if (asObj) return asObj;
  }
  // content may be a JSON-encoded body for some types.
  try {
    const parsed = JSON.parse(content);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

/**
 * Format a duration in milliseconds for at-a-glance reading. Mirrors
 * the formatDurationMs helper in `pipelines-viewer/PipelinesView.tsx`
 * (kept local here so the atom-detail-viewer feature does not depend
 * on the pipelines-viewer surface for a tiny string formatter).
 */
export function formatDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '--';
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}m`;
  const h = m / 60;
  return `${h.toFixed(1)}h`;
}

/**
 * Format a USD cost. `$0.00` is rendered explicitly so the operator
 * sees "this stage cost zero" rather than "no cost data".
 */
export function formatUsd(amount: number | null): string {
  if (amount === null || !Number.isFinite(amount)) return '--';
  return `$${amount.toFixed(amount < 0.01 && amount > 0 ? 4 : 2)}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '--';
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
