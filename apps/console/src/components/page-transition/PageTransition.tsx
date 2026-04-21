import { motion } from 'framer-motion';
import type { ReactNode } from 'react';

/**
 * Subtle route-enter transition wrapper. Every view uses this as its
 * outer element so route changes feel smooth instead of hard-swap.
 * Not a shared-layout transition (those require matched layoutId
 * pairs across the tree); just a consistent fade+rise on mount.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
      style={{ minHeight: '100%' }}
    >
      {children}
    </motion.div>
  );
}
