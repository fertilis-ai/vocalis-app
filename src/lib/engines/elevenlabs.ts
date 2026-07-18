import type { TranscribeFileResult, WordSpan } from "@/lib/engines/local";
import { type ApiDeps, assertOk, wavBlob } from "@/lib/engines/http";
import type { SynthesizedAudio } from "@/lib/engines/port";

// ElevenLabs adapters (M2 item 9 + M5 item 3): Scribe STT, text-to-speech,
// and instant voice cloning. ElevenLabs authenticates with an `xi-api-key`
// header (not Bearer) and TTS returns raw mp3 bytes rather than JSON
// (inspiration.md §8 — also: omit empty optional params entirely).

const STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const VOICES_URL = "https://api.elevenlabs.io/v1/voices";

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

export interface ElevenLabsCreateCloneOptions extends ApiDeps {
  /** Display name for the voice in the ElevenLabs account. */
  name: string;
  /** The clone reference audio (uploaded — this leaves the device). */
  bytes: Uint8Array;
  filename: string;
  description?: string;
}

/**
 * Instant voice clone (M5 item 3): upload the reference audio and get back a
 * voice id usable with `elevenlabsSynthesize`. Callers own the consent dialog
 * ("this leaves the device") and the privacy-mode guard — this function is
 * never reached in privacy mode.
 */
export async function elevenlabsCreateClone(
  options: ElevenLabsCreateCloneOptions,
): Promise<string> {
  const form = new FormData();
  form.append("name", options.name);
  form.append("files", wavBlob(options.bytes), options.filename);
  // Omit empty optionals entirely rather than sending "" (inspiration.md §8).
  if (options.description) form.append("description", options.description);

  const response = await options.fetch(`${VOICES_URL}/add`, {
    method: "POST",
    headers: { "xi-api-key": options.apiKey },
    body: form,
  });
  await assertOk(response, "ElevenLabs");
  const data = (await response.json()) as { voice_id?: string };
  if (!data.voice_id) {
    throw new Error("ElevenLabs clone response had no voice_id");
  }
  return data.voice_id;
}

export interface ElevenLabsVoice {
  voiceId: string;
  name: string;
  /** "premade" | "cloned" | "generated" | "professional" per the API. */
  category: string;
}

/** List the account's voices (premade + cloned) — feeds the provider half of
 * the voice library and lets clone deletion verify what exists. */
export async function elevenlabsListVoices(deps: ApiDeps): Promise<ElevenLabsVoice[]> {
  const response = await deps.fetch(VOICES_URL, {
    headers: { "xi-api-key": deps.apiKey },
  });
  await assertOk(response, "ElevenLabs");
  const data = (await response.json()) as {
    voices?: { voice_id: string; name?: string; category?: string }[];
  };
  return (data.voices ?? []).map((v) => ({
    voiceId: v.voice_id,
    name: v.name ?? v.voice_id,
    category: v.category ?? "premade",
  }));
}

/** Delete a cloned voice from the ElevenLabs account. */
export async function elevenlabsDeleteVoice(
  options: ApiDeps & { voiceId: string },
): Promise<void> {
  const response = await options.fetch(`${VOICES_URL}/${options.voiceId}`, {
    method: "DELETE",
    headers: { "xi-api-key": options.apiKey },
  });
  await assertOk(response, "ElevenLabs");
}
