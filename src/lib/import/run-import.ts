import { deepgramDiarize, deepgramTranscribe } from "@/lib/engines/deepgram";
import { elevenlabsTranscribe } from "@/lib/engines/elevenlabs";
import { findEngine } from "@/lib/engines/descriptors";
import { groqTranscribe } from "@/lib/engines/groq";
import {
  type DiarizationSegment,
  type PipelineEvent,
  type TranscribeFileResult,
  diarizeFile,
  importAudio,
  startImport,
  stopImport,
} from "@/lib/engines/local";
import { type ApiDeps, platformFetch, requireApiKey } from "@/lib/engines/http";
import { openaiTranscribe } from "@/lib/engines/openai";
import {
  type RouterContext,
  resolveEngine,
} from "@/lib/routing/engine-router";
import type { Transcript } from "@/lib/schemas/session";
import {
  persistTranscript,
  toTranscript,
} from "@/lib/sessions/transcript";
import { deletePath, readFileBytes } from "@/lib/storage";
import { sessionAudioPath, useSessionStore } from "@/stores/session-store";
import { useSettingsStore } from "@/stores/settings-store";
import { type ImportTurn, mergeWordsWithDiarization } from "@/lib/import/segments";

// The import orchestrator (spec §2.2B, M3 item 4). Given a created session, a
// source file, and the resolved batch-ASR engine, it normalizes the audio then
// runs one of two paths, persisting the transcript + status to the session
// store either way:
//   local  → the Rust `session_import` pipeline (streams turns + progress);
//   api    → an M2 batch adapter for text/words + a diarization step for
//            speakers (Deepgram when routed there, else the local diarizer).
// It never silently swaps a local engine for an API one or vice-versa — the
// engine is chosen by the caller from the router (spec §3.4).

export type ImportPhase = "normalizing" | "transcribing" | "complete" | "error";

export interface ImportProgress {
  phase: ImportPhase;
  /** 0–1; indeterminate phases report 0. */
  fraction: number;
  message?: string;
  error?: string;
}

export interface RunImportOptions {
  sessionId: string;
  filePath: string;
  /** Resolved batch-ASR engine id (override or task default). */
  engineId: string;
  /** Router context, for resolving the diarization engine on the API path. */
  ctx: RouterContext;
  /** Whisper language code ("auto"/undefined = auto-detect). */
  language?: string;
  onProgress?: (progress: ImportProgress) => void;
}

/** A running import; `cancel` stops the local pipeline (API runs to completion). */
export interface ImportHandle {
  done: Promise<void>;
  cancel: () => Promise<void>;
}

/** Dispatch to the right M2 batch-ASR adapter by the engine's provider. */
async function apiTranscribe(
  engineId: string,
  args: ApiDeps & { bytes: Uint8Array; filename: string; language?: string },
): Promise<TranscribeFileResult> {
  const engine = findEngine("batchAsr", engineId);
  switch (engine?.provider) {
    case "groq":
      return groqTranscribe(args);
    case "openai":
      return openaiTranscribe(args);
    case "elevenlabs":
      return elevenlabsTranscribe(args);
    case "deepgram":
      return deepgramTranscribe(args);
    default:
      throw new Error(`No API transcription adapter for ${engineId}`);
  }
}

/** Resolve speaker spans for the API path: Deepgram when diarization is routed
 *  (and eligible) there, otherwise the local offline diarizer over audio.wav. */
async function apiDiarization(
  ctx: RouterContext,
  audioPath: string,
  bytes: Uint8Array,
  deps: () => ApiDeps,
): Promise<DiarizationSegment[]> {
  const resolved = resolveEngine("diarization", ctx);
  try {
    if (resolved.active?.provider === "deepgram") {
      const { fetch, apiKey } = deps();
      return (await deepgramDiarize({ fetch, apiKey, bytes })).segments;
    }
    if (resolved.active?.kind === "local") {
      return (await diarizeFile(audioPath)).segments;
    }
  } catch (err) {
    // A failed diarization degrades to a single unlabeled speaker, not a hard
    // failure — the transcript is still worth keeping.
    console.warn("[import] diarization failed, falling back to one speaker:", err);
  }
  return [];
}

async function runApiImport(
  options: RunImportOptions,
  audioPath: string,
  durationMs: number,
): Promise<void> {
  const { sessionId, engineId, ctx, language, onProgress } = options;
  const engine = findEngine("batchAsr", engineId);
  const provider = engine?.provider;
  if (!provider) throw new Error(`Unknown API engine ${engineId}`);

  const apiKeys = useSettingsStore.getState().apiKeys;
  const deps = (): ApiDeps => ({
    fetch: platformFetch(),
    apiKey: requireApiKey(apiKeys, provider),
  });

  onProgress?.({ phase: "transcribing", fraction: 0, message: `${engine.label}…` });
  const bytes = await readFileBytes(audioPath);
  const filename = `${sessionId}.wav`;
  const result = await apiTranscribe(engineId, {
    ...deps(),
    bytes,
    filename,
    language,
  });

  const diar = await apiDiarization(ctx, audioPath, bytes, deps);
  // Some batch-ASR adapters (or short/silent clips) return no word timestamps;
  // fall back to one turn spanning the whole clip rather than an empty transcript.
  const turns: ImportTurn[] =
    result.words.length > 0
      ? mergeWordsWithDiarization(result.words, diar)
      : result.text.trim()
        ? [{ speakerLabel: "A", text: result.text.trim(), startMs: 0, endMs: durationMs }]
        : [];
  await persistTranscript(sessionId, toTranscript(turns, false));
  onProgress?.({ phase: "complete", fraction: 1 });
}

function runLocalImport(
  options: RunImportOptions,
  onId: (id: number) => void,
): Promise<void> {
  const { sessionId, language, onProgress } = options;
  // The local batch engine maps to the active asr-batch model via activeByTask,
  // which startImport reads itself; we only pass the language override.

  return new Promise<void>((resolve, reject) => {
    let latest: Transcript = [];
    // Tracks the in-flight "refined" persist so "stopped" can await it before
    // resolving — otherwise the caller can mark the session "complete" while
    // the refined transcript write is still in flight (spec M8).
    let refinedPersisted: Promise<void> = Promise.resolve();
    const onEvent = (event: PipelineEvent) => {
      switch (event.type) {
        case "processing":
          onProgress?.({ phase: "transcribing", fraction: 0, message: event.message });
          break;
        case "speakerTurn":
          // Stream provisional turns so the session view fills in live.
          latest = [...latest, ...toTranscript([event.segment], true)];
          void useSessionStore.getState().saveTranscript(sessionId, latest);
          break;
        case "progress":
          onProgress?.({ phase: "transcribing", fraction: event.fraction });
          break;
        case "refined":
          latest = toTranscript(event.segments, false);
          refinedPersisted = persistTranscript(sessionId, latest);
          break;
        case "error":
          onProgress?.({ phase: "error", fraction: 0, error: event.message });
          reject(new Error(event.message));
          break;
        case "stopped":
          refinedPersisted
            .then(() => {
              onProgress?.({ phase: "complete", fraction: 1 });
              resolve();
            })
            .catch(reject);
          break;
        case "cancelled":
          // Distinct from "stopped": the run was cut short by the user, so the
          // truncated transcript must not be marked complete.
          reject(new Error("Import cancelled"));
          break;
      }
    };
    startImport({ sessionId, language, onEvent }).then(onId, reject);
  });
}

/**
 * Normalize the source file, mark the session an import in progress, then run
 * the routed import path. Returns a handle whose `done` resolves when the
 * transcript is settled (or rejects on error) and whose `cancel` stops a local
 * run. Failures set the session status to "error" with the message.
 */
export function runImport(options: RunImportOptions): ImportHandle {
  const { sessionId, filePath, engineId, onProgress } = options;
  const engine = findEngine("batchAsr", engineId);
  let localId: number | null = null;

  const done = (async () => {
    const store = useSessionStore.getState();
    await store.updateSession(sessionId, {
      mode: "import",
      engineId,
      status: "processing",
      error: undefined,
    });

    try {
      onProgress?.({ phase: "normalizing", fraction: 0, message: "Decoding audio…" });
      const { audioPath, durationMs } = await importAudio(sessionId, filePath);
      await store.updateSession(sessionId, { durationMs });

      if (engine?.kind === "api") {
        await runApiImport(options, audioPath, durationMs);
      } else {
        await runLocalImport(options, (id) => {
          localId = id;
        });
      }
      await store.updateSession(sessionId, { status: "complete" });
      const audioRetained =
        useSessionStore.getState().sessions[sessionId]?.audioRetained ?? true;
      if (!audioRetained) {
        await deletePath(sessionAudioPath(sessionId)).catch(() => {});
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await store.updateSession(sessionId, { status: "error", error: message });
      onProgress?.({ phase: "error", fraction: 0, error: message });
      throw err;
    }
  })();

  return {
    done,
    cancel: async () => {
      if (localId !== null) await stopImport(localId);
    },
  };
}
