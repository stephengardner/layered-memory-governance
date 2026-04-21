import type { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { CompromiseBanner } from '@/components/compromise-banner/CompromiseBanner';
import type { Route } from '@/state/router.store';
import styles from './AppShell.module.css';

/**
 * AppShell: top-level layout primitive. Sidebar + header + scrollable
 * content area. All styling via CSS tokens, no hardcoded px or hex.
 */
export function AppShell({
  route,
  children,
  onPropose,
}: {
  route: Route;
  children: ReactNode;
  onPropose?: () => void;
}) {
  return (
    <div className={styles.shell}>
      <Sidebar route={route} />
      <div className={styles.main}>
        <CompromiseBanner />
        <Header route={route} onPropose={onPropose} />
        <main className={styles.content} data-scroll-root>{children}</main>
      </div>
    </div>
  );
}
