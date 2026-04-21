import { useQuery } from '@tanstack/react-query';
import { AlertOctagon } from 'lucide-react';
import { listPrincipals } from '@/services/principals.service';
import { setRoute } from '@/state/router.store';
import styles from './CompromiseBanner.module.css';

/**
 * Top-of-app safety strip. If ANY principal has a non-null
 * compromised_at, we render a red banner linking to Principals so
 * the operator sees the compromise the moment they open the app.
 *
 * Fires on the same principals query the Principals view uses, so
 * TanStack Query caches the result — no double fetch.
 */
export function CompromiseBanner() {
  const query = useQuery({
    queryKey: ['principals'],
    queryFn: ({ signal }) => listPrincipals(signal),
    staleTime: 60_000,
  });

  const compromised = (query.data ?? []).filter((p) => Boolean(p.compromised_at));
  if (compromised.length === 0) return null;

  const names = compromised.map((p) => p.name ?? p.id).join(', ');

  return (
    <div className={styles.banner} role="alert" data-testid="compromise-banner">
      <AlertOctagon size={16} strokeWidth={2.25} />
      <span className={styles.text}>
        <strong>Compromise detected:</strong> {names} — taint cascades from {compromised.length === 1 ? 'this principal' : 'these principals'} are now suspect.
      </span>
      <button
        type="button"
        className={styles.action}
        onClick={() => setRoute('principals')}
      >
        Open Principals →
      </button>
    </div>
  );
}
