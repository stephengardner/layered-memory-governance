/**
 * Normalize a thrown / rejected value into a human-readable string. Used
 * across the Console wherever `useQuery` exposes `query.error: unknown`
 * to keep error-message rendering consistent and prevent drift.
 */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
