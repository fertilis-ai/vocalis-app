import { useCallback, useEffect, useRef, useState } from "react";
import {
  type PipelineEvent,
  audioFileInfo,
  startSessionPipeline,
  stopSessionPipeline,
} from "@/lib/engines/local";
import type { SessionStatus } from "@/lib/schemas/session";
import {
  type RawTurn,
  persistTranscript,
  toTranscript,
} from "@/lib/sessions/transcript";
import { deletePath } from "@/lib/storage";
import { sessionAudioPath, useSessionStore } from "@/stores/session-store";

// Drives a live transcription session from the webview (spec §2.2B, M3 item 5):
// starts the Rust session pipeline, maps its events onto the session store
// (provisional turns while recording, the settled transcript after the stop-time
// refinement), and advances session.status. The transcript itself is read from
// the store by the view; this hook owns only the transient capture state.

export interface SessionRecorder {
  status: SessionStatus;
  /** In-flight ASR partial (a ghost line), not yet a finalized turn. */
  partial: string;
  /** VAD speaking indicator. */
  speaking: boolean;
  error: string | null;
  /** Message shown during the stop-time refinement pass. */
  processingMessage: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isBusy: boolean;
}

export function useSessionRecorder(sessionId: string): SessionRecorder {
  const [status, setStatus] = useState<SessionStatus>("draft");
  const [partial, setPartial] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [processingMessage, setProcessingMessage] = useState("");
  const pipelineId = useRef<number | null>(null);
  const rawTurns = useRef<RawTurn[]>([]);
  // Tracks the in-flight "refined" persist so "stopped" can await it before
  // marking the session complete — otherwise the status write can land before
  // the refined transcript write, leaving a "complete" session referencing a
  // stale/provisional transcript if the app closes in that window (spec M8).
  const refinedPersisted = useRef<Promise<void>>(Promise.resolve());
  // Set synchronously before the startSessionPipeline await resolves, so a
  // second start() call in the same tick (before pipelineId.current is set)
  // is still rejected.
  const starting = useRef(false);

  const finish = useCallback(
    async (finalStatus: SessionStatus, patch: Record<string, unknown> = {}) => {
      pipelineId.current = null;
      setSpeaking(false);
      setPartial("");
      setStatus(finalStatus);
      await useSessionStore
        .getState()
        .updateSession(sessionId, { status: finalStatus, ...patch });
    },
    [sessionId],
  );

  const onEvent = useCallback(
    (event: PipelineEvent) => {
      switch (event.type) {
        case "partial":
          setPartial(event.text);
          break;
        case "vadState":
          setSpeaking(event.speaking);
          break;
        case "speakerTurn":
          rawTurns.current = [...rawTurns.current, event.segment];
          setPartial("");
          void persistTranscript(sessionId, toTranscript(rawTurns.current, true));
          break;
        case "processing":
          setStatus("processing");
          setProcessingMessage(event.message);
          break;
        case "refined":
          rawTurns.current = event.segments;
          refinedPersisted.current = persistTranscript(
            sessionId,
            toTranscript(event.segments, false),
          );
          break;
        case "error":
          setError(event.message);
          void finish("error", { error: event.message });
          break;
        case "stopped": {
          const lastEnd = rawTurns.current.at(-1)?.endMs ?? 0;
          setProcessingMessage("");
          void (async () => {
            await refinedPersisted.current;
            const info = await audioFileInfo(sessionAudioPath(sessionId)).catch(
              () => null,
            );
            const durationMs = info ? Math.round(info.durationSecs * 1000) : lastEnd;
            const audioRetained =
              useSessionStore.getState().sessions[sessionId]?.audioRetained ?? true;
            if (!audioRetained) {
              await deletePath(sessionAudioPath(sessionId)).catch(() => {});
            }
            await finish("complete", { durationMs });
          })();
          break;
        }
        default:
          break;
      }
    },
    [finish, sessionId],
  );

  const start = useCallback(async () => {
    if (pipelineId.current !== null || starting.current) return;
    starting.current = true;
    setError(null);
    setPartial("");
    setProcessingMessage("");
    rawTurns.current = [];
    setStatus("recording");
    const store = useSessionStore.getState();
    const audioRetained = store.sessions[sessionId]?.audioRetained ?? true;
    await store.saveTranscript(sessionId, []);
    await store.updateSession(sessionId, {
      mode: "live",
      status: "recording",
      error: undefined,
    });
    try {
      pipelineId.current = await startSessionPipeline({
        sessionId,
        audioRetained,
        onEvent,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      await finish("error", { error: message });
    } finally {
      starting.current = false;
    }
  }, [finish, onEvent, sessionId]);

  const stop = useCallback(async () => {
    const id = pipelineId.current;
    if (id === null) return;
    setStatus("processing");
    setProcessingMessage("Refining speakers…");
    await stopSessionPipeline(id);
  }, []);

  // If the view unmounts mid-capture (e.g. switching sessions), stop the Rust
  // pipeline so it flushes audio and releases the single-session guard rather
  // than being orphaned. Provisional turns are already persisted; the settled
  // refinement is lost since this handler is gone — an accepted degradation.
  useEffect(() => {
    return () => {
      if (pipelineId.current !== null) {
        void stopSessionPipeline(pipelineId.current);
        // Best-effort: don't leave the session stuck at "recording" on disk.
        // Skip if the session was already removed (e.g. deleted while
        // recording) — updateSession would otherwise resurrect it on disk.
        if (useSessionStore.getState().sessions[sessionId]) {
          void useSessionStore
            .getState()
            .updateSession(sessionId, { status: "complete" });
        }
      }
    };
  }, [sessionId]);

  const isBusy = status === "recording" || status === "processing";

  return {
    status,
    partial,
    speaking,
    error,
    processingMessage,
    start,
    stop,
    isBusy,
  };
}
