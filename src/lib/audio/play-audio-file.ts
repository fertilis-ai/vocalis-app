import { audioUrl } from "@/lib/engines/local";
import type { PlaybackHandle } from "@/lib/audio/playback-queue";

/**
 * Play one synthesized file through a DOM Audio element as a cancelable
 * `PlaybackHandle` — `done` settles on natural end, playback error, and
 * `stop()` alike. The single audio-element lifecycle for voice-chat playback
 * (use-message-playback.ts predates this and still owns its element directly).
 */
export function playAudioFile(path: string): PlaybackHandle {
  const audio = new Audio(audioUrl(path));
  let settled = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const finish = () => {
    if (settled) return;
    settled = true;
    resolveDone();
  };
  audio.onended = finish;
  audio.onerror = finish;
  void audio.play().catch(finish);
  return {
    done,
    stop: () => {
      audio.pause();
      audio.currentTime = 0;
      finish();
    },
  };
}
