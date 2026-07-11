import * as React from "react";
import { playAudioFile } from "@/lib/audio/play-audio-file";
import { createPlaybackQueue } from "@/lib/audio/playback-queue";
import { createSentenceChunker } from "@/lib/audio/sentence-chunker";
import {
  forceFinalizeChatCapture,
  type PipelineEvent,
  setChatCapturePlayback,
  startChatCapture,
  stopChatCapture,
} from "@/lib/engines/local";
import { synthesizeSpeech } from "@/lib/llm/message-playback";
import { useRouterContext } from "@/lib/routing/use-engine";
import { useSettingsStore } from "@/stores/settings-store";

// Hands-free/push-to-talk voice-chat orchestration (spec M4 item 3/4): drives
// the Rust chat_capture pipeline, turns finalized speech into LLM turns, and
// speaks replies back sentence-by-sentence via the playback queue. Mic
// capture is paused in Rust for the duration of playback (echo mitigation
// v1, spec §3.2/§7.4) — there is no barge-in: the pipeline emits no
// `vadState` events while paused, so a reply can only be interrupted by
// waiting for it to finish.

export type VoiceChatStatus =
  | "idle"
  | "listening"
  | "userSpeaking"
  | "transcribing"
  | "thinking"
  | "speaking";

export type VoiceInputMode = "vad" | "ptt";

export interface UseVoiceChatOptions {
  /** Per-conversation voice for TTS; unset = engine default. */
  voiceId?: string;
  /** Transcript-only mode: capture and reply, but never synthesize/play. */
  ttsEnabled: boolean;
  inputMode: VoiceInputMode;
  /** Silence duration (ms) before a hands-free turn endpoints — Voice Chat
   * settings' VAD silence-threshold slider. Unset = engine default. */
  vadSilenceMs?: number;
  /** Runs one user turn through the normal chat pipeline; `onDelta` streams
   * tokens as they arrive. Resolves once the turn (or its abort) settles. */
  send: (text: string, onDelta: (delta: string) => void) => Promise<void>;
  /** Aborts the in-flight LLM stream — the barge-in half of interrupting a
   * reply; the playback queue's own `clear()` handles the audio half. */
  stopStream: () => void;
}

export interface UseVoiceChatResult {
  active: boolean;
  status: VoiceChatStatus;
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** Push-to-talk hold handlers; no-ops when `inputMode` is "vad". */
  pttDown: () => void;
  pttUp: () => void;
}

export function useVoiceChat(options: UseVoiceChatOptions): UseVoiceChatResult {
  const optionsRef = React.useRef(options);
  optionsRef.current = options;

  const ctx = useRouterContext();
  const ctxRef = React.useRef(ctx);
  ctxRef.current = ctx;

  const [status, setStatus] = React.useState<VoiceChatStatus>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const active = status !== "idle";

  const pipelineIdRef = React.useRef<number | null>(null);
  const queueRef = React.useRef<ReturnType<typeof createPlaybackQueue> | null>(null);
  const speakingRef = React.useRef(false);
  const pttHeldRef = React.useRef(false);
  const pttAccumRef = React.useRef("");
  const pttGenRef = React.useRef(0);
  // True from a `processing` event until the `final`/`error` that resolves
  // it — lets pttUp's flush fallback tell "nothing was buffered, flush now"
  // apart from "a real batch decode is in flight, wait for its `final`".
  const decodingRef = React.useRef(false);
  const activeRef = React.useRef(false);
  const turnGenRef = React.useRef(0);

  const submitTurn = React.useCallback((text: string) => {
    const queue = queueRef.current;
    if (!text.trim() || !activeRef.current || !queue) return;
    // A new turn owns the voice: whatever the previous reply was still saying
    // gets cut off rather than overlapping. Cleared before the status write —
    // clear() reports playback-inactive, which would overwrite "thinking".
    queue.clear();
    setStatus("thinking");

    const turn = ++turnGenRef.current;
    const chunker = createSentenceChunker();
    const onDelta = (delta: string) => {
      if (!optionsRef.current.ttsEnabled) return;
      for (const sentence of chunker.push(delta)) queue.enqueue(sentence);
    };

    void optionsRef.current.send(text, onDelta).then(() => {
      if (optionsRef.current.ttsEnabled) {
        for (const sentence of chunker.flush()) queue.enqueue(sentence);
      }
      if (turnGenRef.current === turn && !speakingRef.current && activeRef.current) {
        setStatus("listening");
      }
    });
  }, []);

  const flushPttAccumulator = React.useCallback(() => {
    const text = pttAccumRef.current.trim();
    pttAccumRef.current = "";
    if (text) submitTurn(text);
  }, [submitTurn]);

  const handleEvent = React.useCallback(
    (event: PipelineEvent) => {
      switch (event.type) {
        case "processing": {
          // Falling edge fired (natural or force-finalize): a batch decode
          // just started. Covers both hands-free and PTT — pttUp's flush
          // fallback reads this ref to avoid racing the `final` it promises.
          decodingRef.current = true;
          if (activeRef.current) setStatus("transcribing");
          break;
        }
        case "final": {
          decodingRef.current = false;
          if (optionsRef.current.inputMode === "ptt") {
            pttAccumRef.current = [pttAccumRef.current, event.text].filter(Boolean).join(" ");
            if (!pttHeldRef.current) flushPttAccumulator();
            break;
          }
          submitTurn(event.text);
          break;
        }
        case "vadState": {
          if (activeRef.current && !speakingRef.current) {
            setStatus(event.speaking ? "userSpeaking" : "listening");
          }
          break;
        }
        case "error": {
          decodingRef.current = false;
          setError(event.message);
          break;
        }
        default:
          break;
      }
    },
    [submitTurn, flushPttAccumulator],
  );

  const start = React.useCallback(async () => {
    if (activeRef.current) return;
    setError(null);
    pttAccumRef.current = "";
    try {
      const id = await startChatCapture({
        onEvent: handleEvent,
        vadSilenceMs: optionsRef.current.vadSilenceMs,
      });
      pipelineIdRef.current = id;
      // One queue for the whole capture session, reused across turns —
      // clear() (barge-in / new turn) resets it without replacing it, so
      // exactly one queue ever drives the Rust playback gate.
      queueRef.current = createPlaybackQueue({
        synthesize: (sentence) =>
          synthesizeSpeech(
            sentence,
            ctxRef.current,
            useSettingsStore.getState().apiKeys,
            optionsRef.current.voiceId,
          ),
        play: playAudioFile,
        setPlaybackActive: (isActive) => {
          speakingRef.current = isActive;
          if (activeRef.current) setStatus(isActive ? "speaking" : "listening");
          const pipelineId = pipelineIdRef.current;
          if (pipelineId !== null) {
            void setChatCapturePlayback(pipelineId, isActive).catch(() => {});
          }
        },
      });
      activeRef.current = true;
      setStatus("listening");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start voice chat.");
    }
  }, [handleEvent]);

  const stop = React.useCallback(async () => {
    activeRef.current = false;
    setStatus("idle");
    pttHeldRef.current = false;
    pttAccumRef.current = "";
    queueRef.current?.clear();
    queueRef.current = null;
    optionsRef.current.stopStream();
    const id = pipelineIdRef.current;
    pipelineIdRef.current = null;
    if (id !== null) await stopChatCapture(id).catch(() => {});
  }, []);

  React.useEffect(() => () => void stop(), [stop]);

  const pttDown = React.useCallback(() => {
    if (optionsRef.current.inputMode !== "ptt" || !activeRef.current) return;
    pttHeldRef.current = true;
    pttGenRef.current++;
    setStatus("userSpeaking");
  }, []);

  const pttUp = React.useCallback(() => {
    if (optionsRef.current.inputMode !== "ptt" || !pttHeldRef.current) return;
    pttHeldRef.current = false;
    const gen = ++pttGenRef.current;
    const id = pipelineIdRef.current;
    if (id !== null) void forceFinalizeChatCapture(id).catch(() => {});
    // Grace window for the trailing `final` from force-finalize. If a batch
    // decode is genuinely in flight, its own `final` handler already flushes
    // immediately on arrival — skip this timer's flush and fall back to a
    // longer safety net instead, in case that `final` never shows up.
    setTimeout(() => {
      if (pttGenRef.current !== gen) return;
      if (decodingRef.current) {
        setTimeout(() => {
          if (pttGenRef.current === gen) flushPttAccumulator();
        }, 5000);
        return;
      }
      flushPttAccumulator();
    }, 400);
  }, [flushPttAccumulator]);

  return { active, status, error, start, stop, pttDown, pttUp };
}
