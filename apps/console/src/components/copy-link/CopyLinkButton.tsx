import { useEffect, useState } from 'react';
import { Link, Check } from 'lucide-react';
import styles from './CopyLinkButton.module.css';

interface Props {
  readonly href: string;
  readonly label?: string;
}

/**
 * Copy an absolute URL to clipboard with a "copied ✓" confirmation
 * that auto-resets after 1.5s. Used on cards as the "share this
 * atom" affordance — the second-best thing after Cmd+K for giving
 * a teammate a deep link.
 *
 * Resolves href relative to window.location.origin so the result is
 * always a complete URL.
 */
export function CopyLinkButton({ href, label = 'Copy link' }: Props) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const url = new URL(href, window.location.origin).toString();
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard can fail on http:// (non-localhost) or denied
      // permissions. Silent-fail is fine; the permalink is still
      // visible in the URL bar of the focused detail view.
    }
  };

  return (
    <button
      type="button"
      className={styles.button}
      onClick={handleCopy}
      aria-label={label}
      data-testid="copy-link"
      data-copied={copied}
    >
      {copied ? <Check size={12} strokeWidth={2.5} /> : <Link size={12} strokeWidth={2} />}
      {copied ? 'copied' : 'copy link'}
    </button>
  );
}
