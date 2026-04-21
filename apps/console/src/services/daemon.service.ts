import { transport } from './transport';

export interface DaemonStatus {
  readonly atomCount: number;
  readonly lastAtomId: string | null;
  readonly lastAtomCreatedAt: string | null;
  readonly secondsSinceLastAtom: number | null;
  readonly atomsInLastHour: number;
  readonly atomsInLastDay: number;
  readonly lagDir: string;
}

export async function getDaemonStatus(signal?: AbortSignal): Promise<DaemonStatus> {
  return transport.call<DaemonStatus>(
    'daemon.status',
    undefined,
    signal ? { signal } : undefined,
  );
}
