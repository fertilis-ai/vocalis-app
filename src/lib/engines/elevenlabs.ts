import type { TranscribeFileResult, WordSpan } from "@/lib/engines/local";
import { type ApiDeps, assertOk, wavBlob } from "@/lib/engines/http";
import type { SynthesizedAudio } from "@/lib/engines/port";

// ElevenLabs adapters (M2 item 9): Scribe STT and text-to-speech. ElevenLabs
// authenticates with an `xi-api-key` header (not Bearer) and TTS returns raw
// mp3 bytes rather than JSON (inspiration.md §8).

const STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";

/** ElevenLabs' default "Rachel" voice — a sensible bench default. */
export const ELEVENLABS_DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM";

interface ScribeWord {
  text: string;
  start: number;
  end?: number;
  /** "word" | "spacing" — spacing tokens are dropped from the timeline. */
  type?: string;
}

interface ScribeResponse {
  text: string;
  words?: ScribeWord[];
}

export interface ElevenLabsTranscribeOptions extends ApiDeps {
  bytes: Uint8Array;
  filename: string;
  model?: string;
  /** Unused by Scribe (it auto-detects) — accepted for a uniform signature. */
  language?: string;
}

export async function elevenlabsTranscribe(
  options: ElevenLabsTranscribeOptions,
): Promise<TranscribeFileResult> {
  const form = new FormData();
  form.append("file", wavBlob(options.bytes), options.filename);
  form.append("model_id", options.model ?? "scribe_v1");

  const startedAt = performance.now();
  const response = await options.fetch(STT_URL, {
    method: "POST",
    headers: { "xi-api-key": options.apiKey },
    body: form,
  });
  await assertOk(response, "ElevenLabs");
  const processingMs = Math.round(performance.now() - startedAt);

  const data = (await response.json()) as ScribeResponse;
  const words: WordSpan[] = (data.words ?? [])
    .filter((w) => w.type !== "spacing")
    .map((w) => ({ text: w.text, start: w.start }));
  // Scribe doesn't report a clip duration directly — derive it from the last
  // word's end timestamp, same as the openai adapter's `duration` field.
  const durationSecs = (data.words ?? []).reduce((max, w) => Math.max(max, w.end ?? w.start), 0);
  return {
    text: data.text ?? "",
    words,
    durationSecs,
    processingMs,
    rtf: durationSecs > 0 ? processingMs / 1000 / durationSecs : 0,
  };
}

export interface ElevenLabsSynthesizeOptions extends ApiDeps {
  text: string;
  /** Voice id (defaults to Rachel). */
  voice?: string;
  model?: string;
}

export async function elevenlabsSynthesize(
  options: ElevenLabsSynthesizeOptions,
): Promise<SynthesizedAudio> {
  const voice = options.voice || ELEVENLABS_DEFAULT_VOICE;
  const response = await options.fetch(`${TTS_URL}/${voice}`, {
    method: "POST",
    headers: {
      "xi-api-key": options.apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: options.text,
      model_id: options.model ?? "eleven_multilingual_v2",
    }),
  });
  await assertOk(response, "ElevenLabs");
  return { bytes: new Uint8Array(await response.arrayBuffer()), ext: "mp3" };
}
