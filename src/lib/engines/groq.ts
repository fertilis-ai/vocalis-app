import type { TranscribeFileResult, WordSpan } from "@/lib/engines/local";
import { type ApiDeps, assertOk, wavBlob } from "@/lib/engines/http";

// Groq batch STT (M2 item 9). Groq exposes an OpenAI-compatible transcription
// endpoint, so the request shape mirrors the OpenAI adapter; the default model
// is whisper-large-v3.

const STT_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

interface VerboseWord {
  word: string;
  start: number;
}

interface VerboseTranscription {
  text: string;
  duration?: number;
  words?: VerboseWord[];
}

export interface GroqTranscribeOptions extends ApiDeps {
  bytes: Uint8Array;
  filename: string;
  model?: string;
  language?: string;
}

export async function groqTranscribe(
  options: GroqTranscribeOptions,
): Promise<TranscribeFileResult> {
  const form = new FormData();
  form.append("file", wavBlob(options.bytes), options.filename);
  form.append("model", options.model ?? "whisper-large-v3");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  if (options.language && options.language !== "auto") {
    form.append("language", options.language);
  }

  const startedAt = performance.now();
  const response = await options.fetch(STT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${options.apiKey}` },
    body: form,
  });
  await assertOk(response, "Groq");
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
