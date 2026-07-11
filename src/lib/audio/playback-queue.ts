// Ordered, cancelable, single-active-playback queue for voice-chat TTS (spec
// M4 item 3). Sentences from the sentence chunker are enqueued as they
// arrive; synthesis look-ahead is bounded to one sentence (N+1 synthesizes
// while N plays) so a new-turn `clear()` leaves at most two uncancelable
// synths running in Rust, not one per remaining sentence. Playback stays
// strictly in order and one at a time. Dependency-injected
// (synthesize/play/setPlaybackActive) so this stays pure TS and testable
// without Tauri or the DOM Audio element — the real wiring (ttsSynthesize,
// an <audio> element, chat_capture_set_playback) lives in the caller.

import {
  MAX_SPEECH_INPUT_CHARS,
  stripMarkdownForSpeech,
} from "@/lib/llm/strip-markdown-for-speech";

/** A single, cancelable playback of one synthesized file. `done` resolves
 * both when playback finishes naturally and when `stop()` cancels it. */
export interface PlaybackHandle {
  done: Promise<void>;
  stop: () => void;
}

export interface PlaybackQueueDeps {
  /** Synthesize one (already markdown-stripped) sentence to a playable path. */
  synthesize: (text: string) => Promise<{ path: string }>;
  /** Play a synthesized file. */
  play: (path: string) => PlaybackHandle;
  /** Reports queue-level play/pause to Rust, which pauses mic capture into
   * VAD/ASR for echo mitigation (spec §3.2/§7.4) — toggled once when the
   * queue starts producing audio and once when it fully drains, not per
   * sentence, so brief inter-sentence gaps don't drop the mic pause. */
  setPlaybackActive: (active: boolean) => void;
  /** Called when a sentence fails to synthesize; that sentence is skipped
   * and the queue continues with the next one. */
  onError?: (error: unknown, text: string) => void;
}

export interface PlaybackQueue {
  /** Enqueue a raw sentence (markdown stripped internally before synthesis). */
  enqueue(text: string): void;
  /** Stop current playback and drop everything queued — e.g. a new turn
   * cutting off whatever the previous reply was still saying. */
  clear(): void;
}

interface QueueItem {
  text: string;
  /** Started lazily by the pump (current item + one look-ahead). */
  synth?: Promise<{ path: string } | null>;
}

export function createPlaybackQueue(deps: PlaybackQueueDeps): PlaybackQueue {
  let queue: QueueItem[] = [];
  let pumping = false;
  let active = false;
  let stopCurrent: (() => void) | null = null;
  let generation = 0;

  function setActive(next: boolean) {
    if (active === next) return;
    active = next;
    deps.setPlaybackActive(next);
  }

  function startSynth(item: QueueItem): Promise<{ path: string } | null> {
    item.synth ??= deps.synthesize(item.text).catch((error: unknown) => {
      deps.onError?.(error, item.text);
      return null;
    });
    return item.synth;
  }

  async function pump(gen: number): Promise<void> {
    while (queue.length > 0) {
      if (gen !== generation) return;
      const item = queue[0];
      const synth = startSynth(item);
      if (queue[1]) startSynth(queue[1]);
      queue.shift();
      const result = await synth;
      if (gen !== generation) return;
      if (result === null) continue;

      setActive(true);
      const handle = deps.play(result.path);
      stopCurrent = handle.stop;
      await handle.done;
      stopCurrent = null;
      if (gen !== generation) return;
    }
    setActive(false);
    pumping = false;
  }

  return {
    enqueue(text: string) {
      const input = stripMarkdownForSpeech(text).slice(0, MAX_SPEECH_INPUT_CHARS);
      if (!input) return;

      queue.push({ text: input });

      if (!pumping) {
        pumping = true;
        void pump(generation);
      } else if (queue.length === 1) {
        // The pump already holds the current item; this one is the immediate
        // next, so it gets the one-sentence synthesis look-ahead.
        startSynth(queue[0]);
      }
    },
    clear() {
      generation++;
      queue = [];
      const stop = stopCurrent;
      stopCurrent = null;
      pumping = false;
      stop?.();
      setActive(false);
    },
  };
}
