import * as React from "react";
import { audioUrl } from "@/lib/engines/local";
import { synthesizeMessageSpeech } from "@/lib/llm/message-playback";
import { useRouterContext } from "@/lib/routing/use-engine";
import { useSettingsStore } from "@/stores/settings-store";

export type PlaybackStatus = "idle" | "loading" | "playing";

export interface UseMessagePlaybackResult {
  /** Id of the message currently loading/playing; null when idle. */
  activeId: string | null;
  status: PlaybackStatus;
  error: string | null;
  /** Toggle playback for one message: starts it (stopping any other), or stops it if already active. */
  play: (id: string, text: string) => void;
  stop: () => void;
}

/**
 * Read-aloud playback for a conversation (spec M4 item 2). Single-active:
 * starting a new message's playback stops whichever one was playing.
 * Synthesized paths are cached per (id, text) so replaying skips synthesis.
 */
export function useMessagePlayback(voiceId?: string): UseMessagePlaybackResult {
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<PlaybackStatus>("idle");
  const [error, setError] = React.useState<string | null>(null);

  const ctx = useRouterContext();
  const ctxRef = React.useRef(ctx);
  ctxRef.current = ctx;
  const voiceIdRef = React.useRef(voiceId);
  voiceIdRef.current = voiceId;

  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const cacheRef = React.useRef<{ id: string; text: string; path: string } | null>(null);
  // Bumped on every stop/new play so a late-resolving synthesis can't clobber
  // a more recent stop or a different message's play.
  const tokenRef = React.useRef(0);
  const mountedRef = React.useRef(true);

  React.useEffect(
    () => () => {
      mountedRef.current = false;
      audioRef.current?.pause();
    },
    [],
  );

  const stop = React.useCallback(() => {
    tokenRef.current++;
    audioRef.current?.pause();
    if (audioRef.current) audioRef.current.currentTime = 0;
    setStatus("idle");
    setActiveId(null);
  }, []);

  const play = React.useCallback(
    (id: string, text: string) => {
      if (activeId === id && status !== "idle") {
        stop();
        return;
      }

      const token = ++tokenRef.current;
      audioRef.current?.pause();
      setActiveId(id);
      setError(null);

      void (async () => {
        try {
          let path: string;
          if (cacheRef.current?.id === id && cacheRef.current.text === text) {
            path = cacheRef.current.path;
          } else {
            setStatus("loading");
            const res = await synthesizeMessageSpeech(
              text,
              ctxRef.current,
              useSettingsStore.getState().apiKeys,
              voiceIdRef.current,
            );
            if (!mountedRef.current || token !== tokenRef.current) return;
            path = res.path;
            cacheRef.current = { id, text, path };
          }

          const audio = new Audio(audioUrl(path));
          audioRef.current = audio;
          audio.onended = () => {
            if (token === tokenRef.current) stop();
          };
          audio.onerror = () => {
            if (token === tokenRef.current) stop();
          };
          setStatus("playing");
          await audio.play();
        } catch (err) {
          if (!mountedRef.current || token !== tokenRef.current) return;
          setError(err instanceof Error ? err.message : String(err));
          setStatus("idle");
          setActiveId(null);
        }
      })();
    },
    [activeId, status, stop],
  );

  return { activeId, status, error, play, stop };
}
