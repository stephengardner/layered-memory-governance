/**
 * Telegram-specific notifier + formatting + cli-renderer channel.
 *
 * The generic Notifier interface lives in substrate/interface.ts.
 * Telegram-specific message splitting, HTML formatting, and the
 * cli-renderer channel adapter live here under the adapters/
 * subpath so vendor concerns do not leak into the framework's
 * top-level surface.
 */

export * from './notifier.js';
export * from './format.js';
export * from './channel.js';
