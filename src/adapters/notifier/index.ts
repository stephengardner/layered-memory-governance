/**
 * Notifier adapters.
 *
 * The file-queue and memory notifiers ship inside the file / memory host
 * factories because they are the V0 defaults every adapter needs. This
 * sub-path exposes optional alternative channels (Telegram, etc) that you
 * compose over a base notifier.
 */

export {
  TelegramNotifier,
  parseCallbackData,
  type TelegramNotifierOptions,
} from './telegram.js';
