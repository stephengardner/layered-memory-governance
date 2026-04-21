/**
 * Whisper-backed voice transcription adapter. Currently the only
 * transcriber implementation; lives under adapters/transcriber/
 * alongside future implementations (Deepgram, AssemblyAI, etc.).
 *
 * The generic transcriber interface is not yet formalized because
 * there is only one implementation; when a second one arrives the
 * interface extracts up to adapters/transcriber/index.ts.
 */
export {
  StubTranscriber,
  WhisperLocalTranscriber,
  downloadTelegramFile,
} from './whisper.js';
export type {
  VoiceTranscriber,
  WhisperLocalOptions,
  TelegramVoice,
} from './whisper.js';
