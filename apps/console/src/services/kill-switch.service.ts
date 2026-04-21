import { transport } from './transport';

/**
 * Kill-switch tier state. Backend reads from .lag/kill-switch/state.json
 * (or equivalent) and returns the active tier. UI surfaces it in the
 * header so the current autonomy posture is always visible.
 */
export type KillSwitchTier = 'off' | 'soft' | 'medium' | 'hard';

export interface KillSwitchState {
  readonly tier: KillSwitchTier;
  readonly since: string | null;
  readonly reason: string | null;
  readonly autonomyDial: number; // 0 (fully gated) .. 1 (fully autonomous)
}

export async function getKillSwitchState(signal?: AbortSignal): Promise<KillSwitchState> {
  return transport.call<KillSwitchState>(
    'kill-switch.state',
    undefined,
    signal ? { signal } : undefined,
  );
}
