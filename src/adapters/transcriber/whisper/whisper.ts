/**
 * Voice message transcription (Phase 48, pluggable input modality).
 *
 * Telegram users can send voice messages alongside text. LAG's
 * daemon accepts voice as a first-class input: the bot downloads
 * the audio via `getFile`, a pluggable `VoiceTranscriber` turns it
 * into text, and the text flows through the same handler as a
 * regular message. Original voice file id + duration land in the
 * atom metadata so the lineage back to the audio survives.
 *
 * Pluggable: solo devs can use the local Whisper adapter (offline,
 * free); enterprises can swap in Azure / Google / AWS Transcribe /
 * a self-hosted endpoint with no changes to the daemon.
 */

export interface VoiceTranscriber {
  /** Stable id for audit / metadata tagging. */
  readonly id: string;
  /**
   * Transcribe an audio payload. mime is typically 'audio/ogg' for
   * Telegram voice messages. Returns the text; throws on failure.
   */
  transcribe(audio: Buffer, mime: string): Promise<string>;
}

/**
 * Deterministic stub for tests and dry-run daemons. Returns a
 * canned phrase built from the audio bytes' size so different
 * test audios produce different transcripts.
 */
export class StubTranscriber implements VoiceTranscriber {
  readonly id = 'stub';
  constructor(private readonly cannedResponse?: string) {}
  async transcribe(audio: Buffer, mime: string): Promise<string> {
    if (this.cannedResponse !== undefined) return this.cannedResponse;
    return `[stub transcript: ${audio.length} bytes of ${mime}]`;
  }
}

/**
 * Transcriber that uses `@huggingface/transformers` to run Whisper
 * locally. Already a LAG dep for ONNX embeddings, so no new runtime
 * requirement; the first call downloads the model (~75MB for the
 * tiny variant, ~200MB for base). Deterministic given the same
 * audio + model variant.
 *
 * NOTE: this is a thin wrapper that defers the transformers import
 * until first call so the rest of the daemon does not pay the
 * startup cost. The wrapper intentionally does not stream audio;
 * voice messages are typically short, so one-shot transcription is
 * the right tradeoff.
 */
export interface WhisperLocalOptions {
  /**
   * Hugging Face model id. Defaults to 'Xenova/whisper-tiny.en' for
   * English-only, small model. Use 'Xenova/whisper-base' for
   * multilingual, larger.
   */
  readonly model?: string;
}

export class WhisperLocalTranscriber implements VoiceTranscriber {
  readonly id: string;
  private readonly modelId: string;
  private pipelineRef: unknown = null;

  constructor(options: WhisperLocalOptions = {}) {
    this.modelId = options.model ?? 'Xenova/whisper-tiny.en';
    this.id = `whisper-local:${this.modelId}`;
  }

  async transcribe(audio: Buffer, _mime: string): Promise<string> {
    if (!this.pipelineRef) {
      // Dynamic import so tests / callers that never use voice do not
      // pay the module-init cost.
      const mod = (await import('@huggingface/transformers')) as unknown as {
        pipeline: (task: string, model: string) => Promise<unknown>;
      };
      this.pipelineRef = await mod.pipeline('automatic-speech-recognition', this.modelId);
    }
    // The pipeline accepts a Float32Array of raw PCM samples OR a URL.
    // For a Buffer containing encoded audio (Telegram sends Opus in OGG),
    // we pass a data: URL so the pipeline decodes it via the bundled
    // media decoder.
    const base64 = audio.toString('base64');
    const dataUrl = `data:audio/ogg;base64,${base64}`;
    const pipeline = this.pipelineRef as (input: string) => Promise<{ text?: string }>;
    const result = await pipeline(dataUrl);
    return (result.text ?? '').trim();
  }
}

/**
 * Shape of the Telegram `voice` object (subset used by the daemon).
 * See https://core.telegram.org/bots/api#voice.
 */
export interface TelegramVoice {
  readonly file_id: string;
  readonly file_unique_id?: string;
  readonly duration: number;
  readonly mime_type?: string;
  readonly file_size?: number;
}

/**
 * Fetch a Telegram file by file_id. Two calls: getFile (returns a
 * file_path), then download https://api.telegram.org/file/bot<token>/<file_path>.
 * Returns the raw bytes.
 */
export async function downloadTelegramFile(
  botToken: string,
  fileId: string,
  fetchImpl: typeof fetch,
): Promise<{ audio: Buffer; mime: string }> {
  const metaUrl = `https://api.telegram.org/bot${botToken}/getFile`;
  const metaRes = await fetchImpl(metaUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });
  const metaJson = (await metaRes.json()) as {
    ok: boolean;
    result?: { file_path: string };
    description?: string;
  };
  if (!metaJson.ok || !metaJson.result) {
    throw new Error(
      `Telegram getFile failed: ${metaJson.description ?? 'unknown'}`,
    );
  }
  const filePath = metaJson.result.file_path;
  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const fileRes = await fetchImpl(downloadUrl);
  if (!fileRes.ok) {
    throw new Error(`Telegram file download failed: ${fileRes.status}`);
  }
  const arrayBuffer = await fileRes.arrayBuffer();
  const mime = fileRes.headers.get('content-type') ?? 'audio/ogg';
  return { audio: Buffer.from(arrayBuffer), mime };
}
