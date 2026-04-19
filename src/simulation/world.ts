/**
 * Simulated world state with time-indexed facts.
 *
 * Ground-truth oracle for simulation scenarios. Facts transition over time
 * as events are applied. `oracle(id, tick)` answers "what was true about
 * <id> at <tick>?" by walking the fact's history.
 */

export interface WorldFact {
  readonly id: string;
  readonly value: string;
  readonly sinceTick: number;
}

export class World {
  private readonly facts = new Map<string, WorldFact[]>();

  /** Set a fact value at the given tick. Supersedes the prior value, if any. */
  setFact(id: string, value: string, atTick: number): void {
    const history = this.facts.get(id) ?? [];
    const last = history[history.length - 1];
    if (last && atTick < last.sinceTick) {
      throw new Error(
        `World.setFact(${id}): cannot set at tick ${atTick} after tick ${last.sinceTick}`,
      );
    }
    history.push({ id, value, sinceTick: atTick });
    this.facts.set(id, history);
  }

  /**
   * Ground-truth oracle: the value of fact <id> at <tick>.
   * Returns the latest fact value whose sinceTick <= the query tick.
   * Returns null if the fact was never set before <tick>.
   */
  oracle(id: string, atTick: number): string | null {
    const history = this.facts.get(id);
    if (!history) return null;
    let best: WorldFact | null = null;
    for (const entry of history) {
      if (entry.sinceTick <= atTick) {
        best = entry;
      } else {
        break;
      }
    }
    return best?.value ?? null;
  }

  /** All fact ids currently tracked. */
  ids(): ReadonlyArray<string> {
    return Array.from(this.facts.keys());
  }

  /** Full history for a fact. Newest last. */
  history(id: string): ReadonlyArray<WorldFact> {
    return this.facts.get(id) ?? [];
  }
}
