import type {
  DiarizationSegment,
  DiarizeFileResult,
  TranscribeFileResult,
  WordSpan,
} from "@/lib/engines/local";
import { type ApiDeps, assertOk } from "@/lib/engines/http";

// Deepgram batch (prerecorded) adapters (M2 item 9): STT and diarization off
// the same /v1/listen endpoint. Auth is a `Token <key>` header; the body is the
// raw wav bytes. Streaming (WebSocket) is deferred — see the item 9 note in
// spec/M2.md.

const LISTEN_URL = "https://api.deepgram.com/v1/listen";

interface DeepgramWord {
  word: string;
  start: number;
  end: number;
  speaker?: number;
}

interface DeepgramResponse {
  metadata?: { duration?: number };
  results?: {
    channels?: {
      alternatives?: { transcript?: string; words?: DeepgramWord[] }[];
    }[];
  };
}

function firstAlternative(data: DeepgramResponse) {
  return data.results?.channels?.[0]?.alternatives?.[0];
}

async function listen(
  deps: ApiDeps,
  bytes: Uint8Array,
  params: Record<string, string>,
): Promise<{ data: DeepgramResponse; processingMs: number }> {
  const query = new URLSearchParams({ model: "nova-2", ...params }).toString();
  const startedAt = performance.now();
  const response = await deps.fetch(`${LISTEN_URL}?${query}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${deps.apiKey}`,
      "Content-Type": "audio/wav",
    },
    body: bytes as unknown as BodyInit,
  });
  await assertOk(response, "Deepgram");
  const processingMs = Math.round(performance.now() - startedAt);
  return { data: (await response.json()) as DeepgramResponse, processingMs };
}

export interface DeepgramTranscribeOptions extends ApiDeps {
  bytes: Uint8Array;
  language?: string;
}

export async function deepgramTranscribe(
  options: DeepgramTranscribeOptions,
): Promise<TranscribeFileResult> {
  const params: Record<string, string> = { punctuate: "true", smart_format: "true" };
  if (options.language && options.language !== "auto") {
    params.language = options.language;
  }
  const { data, processingMs } = await listen(options, options.bytes, params);
  const alt = firstAlternative(data);
  const words: WordSpan[] = (alt?.words ?? []).map((w) => ({
    text: w.word,
    start: w.start,
  }));
  const durationSecs = data.metadata?.duration ?? 0;
  return {
    text: alt?.transcript ?? "",
    words,
    durationSecs,
    processingMs,
    rtf: durationSecs > 0 ? processingMs / 1000 / durationSecs : 0,
  };
}

export interface DeepgramDiarizeOptions extends ApiDeps {
  bytes: Uint8Array;
}

export async function deepgramDiarize(
  options: DeepgramDiarizeOptions,
): Promise<DiarizeFileResult> {
  const { data, processingMs } = await listen(options, options.bytes, {
    diarize: "true",
    punctuate: "true",
  });
  const words = firstAlternative(data)?.words ?? [];
  const segments = mergeWordsBySpeaker(words);
  const durationSecs = data.metadata?.duration ?? 0;
  const numSpeakers = new Set(segments.map((s) => s.speaker)).size;
  return { durationSecs, processingMs, numSpeakers, segments };
}

/** Collapse consecutive same-speaker words into contiguous segments. */
export function mergeWordsBySpeaker(words: DeepgramWord[]): DiarizationSegment[] {
  const segments: DiarizationSegment[] = [];
  for (const word of words) {
    const speaker = word.speaker ?? 0;
    const last = segments[segments.length - 1];
    if (last && last.speaker === speaker) {
      last.end = word.end;
    } else {
      segments.push({ start: word.start, end: word.end, speaker });
    }
  }
  return segments;
}
