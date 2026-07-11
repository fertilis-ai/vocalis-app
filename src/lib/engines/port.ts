import type { EngineDescriptor } from "@/lib/engines/descriptors";
import {
  type DiarizeFileResult,
  type TranscribeFileResult,
  asrTranscribeFile,
  asrTranscribeFileStreaming,
  diarizeFile,
  ttsCacheEvict,
  ttsSynthesize,
} from "@/lib/engines/local";
import { platformFetch, requireApiKey } from "@/lib/engines/http";
import { deepgramDiarize, deepgramTranscribe } from "@/lib/engines/deepgram";
import { elevenlabsSynthesize, elevenlabsTranscribe } from "@/lib/engines/elevenlabs";
import { groqTranscribe } from "@/lib/engines/groq";
import { openaiSynthesize, openaiTranscribe } from "@/lib/engines/openai";
import { getAppDataDir, isDesktop, pathExists, readFileBytes, writeFileBytes } from "@/lib/storage";

// One dispatch surface per task (spec §3.4): bench pages and pipelines call
// these and never branch on local-vs-API. Each function resolves the concrete
// implementation from the active EngineDescriptor. There is never a silent
// fallback across the boundary — an API failure surfaces as a thrown error.

/** Raw audio returned by a synthesis adapter, before it is persisted to disk. */
export interface SynthesizedAudio {
  bytes: Uint8Array;
  /** File extension for the container ("wav", "mp3"). */
  ext: string;
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

// ── Batch transcription ────────────────────────────────────────────────────

export interface TranscribeOptions {
  apiKeys: Record<string, string>;
  language?: string;
  /** Local model id override (local engines only). */
  localModel?: string;
}

/** Transcribe a wav file through whichever engine `descriptor` names. */
export async function transcribeWithEngine(
  descriptor: EngineDescriptor,
  path: string,
  options: TranscribeOptions,
): Promise<TranscribeFileResult> {
  if (descriptor.kind === "local") {
    if (descriptor.task === "streamingAsr") {
      return asrTranscribeFileStreaming(path, { model: options.localModel });
    }
    return asrTranscribeFile(path, {
      model: options.localModel,
      language: options.language,
    });
  }

  const apiKey = requireApiKey(options.apiKeys, descriptor.provider ?? "");
  const deps = { fetch: platformFetch(), apiKey };
  const bytes = await readFileBytes(path);
  const filename = basename(path);
  switch (descriptor.provider) {
    case "openai":
      return openaiTranscribe({ ...deps, bytes, filename, language: options.language });
    case "groq":
      return groqTranscribe({ ...deps, bytes, filename, language: options.language });
    case "elevenlabs":
      return elevenlabsTranscribe({ ...deps, bytes, filename, language: options.language });
    case "deepgram":
      return deepgramTranscribe({ ...deps, bytes, language: options.language });
    default:
      throw new Error(`No transcription adapter for ${descriptor.id}`);
  }
}

// ── Diarization ─────────────────────────────────────────────────────────────

export interface DiarizeOptions {
  apiKeys: Record<string, string>;
  numSpeakers?: number;
  threshold?: number;
}

/** Diarize a wav file through whichever engine `descriptor` names. */
export async function diarizeWithEngine(
  descriptor: EngineDescriptor,
  path: string,
  options: DiarizeOptions,
): Promise<DiarizeFileResult> {
  if (descriptor.kind === "local") {
    return diarizeFile(path, {
      numSpeakers: options.numSpeakers,
      threshold: options.threshold,
    });
  }
  if (descriptor.provider !== "deepgram") {
    throw new Error(`No diarization adapter for ${descriptor.id}`);
  }
  const apiKey = requireApiKey(options.apiKeys, "deepgram");
  const bytes = await readFileBytes(path);
  return deepgramDiarize({ fetch: platformFetch(), apiKey, bytes });
}

// ── Synthesis ─────────────────────────────────────────────────────────────

export interface SynthesizeResult {
  /** Absolute path to the produced wav/mp3, playable via the asset protocol. */
  path: string;
  cached: boolean;
  processingMs: number;
}

export interface LocalSynthTarget {
  kind: "local";
  modelId: string;
  sid: number;
}

export interface ApiSynthTarget {
  kind: "api";
  provider: "openai" | "elevenlabs";
  /** OpenAI voice name or ElevenLabs voice id. */
  voice: string;
  model?: string;
}

export type SynthTarget = LocalSynthTarget | ApiSynthTarget;

/**
 * Whether `target` actually honors the speed multiplier. Local synthesis
 * always does; OpenAI only on the legacy tts-1 / tts-1-hd models (not the
 * gpt-4o-mini-tts default); ElevenLabs doesn't expose speed control at all.
 * UI should disable the speed control rather than send a value the engine
 * silently ignores.
 */
export function targetSupportsSpeed(target: SynthTarget): boolean {
  if (target.kind === "local") return true;
  if (target.provider === "openai") return (target.model ?? "gpt-4o-mini-tts") !== "gpt-4o-mini-tts";
  return false;
}

/** Synthesize `text` and return a playable file path (local cache or API). */
export async function synthesizeWithTarget(
  target: SynthTarget,
  text: string,
  options: { apiKeys: Record<string, string>; speed?: number },
): Promise<SynthesizeResult> {
  if (target.kind === "local") {
    const startedAt = performance.now();
    const res = await ttsSynthesize(text, {
      model: target.modelId,
      speakerId: target.sid,
      speed: options.speed,
    });
    return {
      path: res.path,
      cached: res.cached,
      processingMs: Math.round(performance.now() - startedAt),
    };
  }

  const apiKey = requireApiKey(options.apiKeys, target.provider);
  const deps = { fetch: platformFetch(), apiKey };
  const startedAt = performance.now();

  const cachedPath = await apiCachePath(target.provider, target.voice, target.model, text, options.speed);
  if (await pathExists(cachedPath)) {
    return { path: cachedPath, cached: true, processingMs: Math.round(performance.now() - startedAt) };
  }

  const audio =
    target.provider === "openai"
      ? await openaiSynthesize({ ...deps, text, voice: target.voice, model: target.model, speed: options.speed })
      : await elevenlabsSynthesize({ ...deps, text, voice: target.voice, model: target.model });
  const processingMs = Math.round(performance.now() - startedAt);

  const path = await persistSynthesis(target.provider, target.voice, target.model, text, options.speed, audio);
  await ttsCacheEvict();
  return { path, cached: false, processingMs };
}

/** File extension each provider's TTS endpoint returns — fixed per provider,
 * so the cache path can be computed before making the request. */
const PROVIDER_TTS_EXT: Record<ApiSynthTarget["provider"], string> = {
  openai: "wav",
  elevenlabs: "mp3",
};

/** Content-addressed cache path for an API synthesis request. Includes
 * speed and model so distinct requests never collide on one file. */
async function apiCachePath(
  provider: ApiSynthTarget["provider"],
  voice: string,
  model: string | undefined,
  text: string,
  speed: number | undefined,
): Promise<string> {
  if (!isDesktop()) throw new Error("API synthesis requires the desktop app");
  const dir = await getAppDataDir();
  if (!dir) throw new Error("no app data dir");
  const hash = hashString(`${provider}:${voice}:${model ?? ""}:${speed ?? 1}:${text}`);
  return `${dir}/cache/tts/${provider}-${hash}.${PROVIDER_TTS_EXT[provider]}`;
}

/** Write API-synthesized audio into the TTS cache so the bench can play it. */
async function persistSynthesis(
  provider: ApiSynthTarget["provider"],
  voice: string,
  model: string | undefined,
  text: string,
  speed: number | undefined,
  audio: SynthesizedAudio,
): Promise<string> {
  const path = await apiCachePath(provider, voice, model, text, speed);
  await writeFileBytes(path, audio.bytes);
  return path;
}

/** Small stable string hash (FNV-1a) for cache filenames. */
function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
