/**
 * FreshSource: the no-op SessionSource.
 *
 * Writes nothing. Useful when:
 *   - Starting from an intentionally empty state.
 *   - Demonstrating that composition with a real source still works
 *     (Fresh + X == X; proves the interface is clean).
 *   - Dry-run smoke tests where a source is required but no data
 *     should land.
 */

import type { Host } from '../substrate/interface.js';
import type { IngestOptions, IngestReport, SessionSource } from './types.js';

export class FreshSource implements SessionSource {
  readonly id = 'fresh';
  readonly description = 'No-op source. Starts LAG from an empty state.';

  async ingest(_host: Host, _options: IngestOptions): Promise<IngestReport> {
    return {
      sourceId: this.id,
      atomsWritten: 0,
      atomsSkipped: 0,
      errors: [],
      sampleAtomIds: [],
    };
  }
}
