import type { TranscribeFileResult, WordSpan } from "@/lib/engines/local";
import { type ApiDeps, assertOk, wavBlob } from "@/lib/engines/http";
import type { SynthesizedAudio } from "@/lib/engines/port";

// OpenAI adapters (spec §3.4, M2 item 9). Batch STT via /v1/audio/transcriptions
// and TTS via /v1/audio/speech. Keys come from the keychain-backed settings
// store; all requests route through the Tauri HTTP plugin to dodge WKWebView CORS.

const STT_URL = "https://api.openai.com/v1/audio/transcriptions";
const TTS_URL = "https://api.openai.com/v1/audio/speech";

interface VerboseWord {
  word: string;
  start: number;
}

interface VerboseTranscription {
  text: string;
  duration?: number;
  words?: VerboseWord[];
}

export interface OpenAiTranscribeOptions extends ApiDeps {
  bytes: Uint8Array;
  filename: string;
  /** whisper-1 (word timestamps) or gpt-4o-transcribe (text only). */
  model?: string;
  /** ISO code; omitted for auto-detect (empty optional params are dropped). */
  language?: string;
}

export async function openaiTranscribe(
  options: OpenAiTranscribeOptions,
): Promise<TranscribeFileResult> {
  const model = options.model ?? "whisper-1";
  const form = new FormData();
  form.append("file", wavBlob(options.bytes), options.filename);
  form.append("model", model);
  // whisper-1 is the only model that returns word timestamps.
  if (model === "whisper-1") {
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
  }
  if (options.language && options.language !== "auto") {
    form.append("language", options.language);
  }

  const startedAt = performance.now();
  const response = await options.fetch(STT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${options.apiKey}` },
    body: form,
  });
  await assertOk(response, "OpenAI");
  const processingMs = Math.round(performance.now() - startedAt);

  const data = (await response.json()) as VerboseTranscription;
  const words: WordSpan[] = (data.words ?? []).map((w) => ({
    text: w.word,
    start: w.start,
  }));
  const durationSecs = data.duration ?? 0;
  return {
    text: data.text ?? "",
    words,
    durationSecs,
    processingMs,
    rtf: durationSecs > 0 ? processingMs / 1000 / durationSecs : 0,
  };
}

export interface OpenAiSynthesizeOptions extends ApiDeps {
  text: string;
  voice: string;
  model?: string;
  speed?: number;
}

export async function openaiSynthesize(
  options: OpenAiSynthesizeOptions,
): Promise<SynthesizedAudio> {
  const model = options.model ?? "gpt-4o-mini-tts";
  const body: Record<string, unknown> = {
    model,
    voice: options.voice,
    input: options.text,
    response_format: "wav",
  };
  // Only the legacy tts-1 / tts-1-hd models accept `speed` — gpt-4o-mini-tts
  // rejects it.
  if (options.speed && options.speed !== 1 && model !== "gpt-4o-mini-tts") {
    body.speed = options.speed;
  }

  const response = await options.fetch(TTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  await assertOk(response, "OpenAI");
  return { bytes: new Uint8Array(await response.arrayBuffer()), ext: "wav" };
}
