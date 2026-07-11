import type { DiarizationSegment, WordSpan } from "@/lib/engines/local";
import { speakerLetter } from "@/lib/speaker-labels";

// Pure segment construction for the API import path (M3 item 4). API ASR
// adapters return a flat word list with start times but no speaker turns; the
// local Rust import builds turns per diarization span itself, but for API ASR we
// merge here: attribute each word to the diarization span covering it, then
// group consecutive same-speaker words into speaker turns. Unit-tested.

/** One finished speaker turn (no id/personId — the store assigns those). */
export interface ImportTurn {
  speakerLabel: string;
  text: string;
  startMs: number;
  endMs: number;
}

/** The diarization speaker covering `t` (seconds): the span containing it, else
 *  the nearest span by gap, else 0 when there's no diarization at all. */
function speakerAt(t: number, diar: DiarizationSegment[]): number {
  if (diar.length === 0) return 0;
  let best = diar[0];
  let bestGap = Number.POSITIVE_INFINITY;
  for (const span of diar) {
    if (t >= span.start && t < span.end) return span.speaker;
    const gap = t < span.start ? span.start - t : t - span.end;
    if (gap < bestGap) {
      bestGap = gap;
      best = span;
    }
  }
  return best.speaker;
}

/**
 * Merge flat ASR words with diarization spans into speaker-labeled turns.
 * A word's end is the next word's start (the last word extends to its span end
 * or +0.5 s). Consecutive words with the same speaker join one turn; speakers
 * are renumbered by first appearance so the first is "A".
 */
export function mergeWordsWithDiarization(
  words: WordSpan[],
  diar: DiarizationSegment[],
): ImportTurn[] {
  if (words.length === 0) return [];

  // Renumber raw diarization speaker ids by first appearance → cluster index.
  const order: number[] = [];
  const clusterOf = (speaker: number): number => {
    let idx = order.indexOf(speaker);
    if (idx === -1) {
      idx = order.length;
      order.push(speaker);
    }
    return idx;
  };

  const turns: ImportTurn[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const cluster = clusterOf(speakerAt(word.start, diar));
    const nextStart = words[i + 1]?.start;
    const spanEnd =
      diar.find((s) => word.start >= s.start && word.start < s.end)?.end ??
      word.start + 0.5;
    const endSec = nextStart ?? spanEnd;

    const last = turns[turns.length - 1];
    const label = speakerLetter(cluster);
    const text = word.text.trim();
    if (last && last.speakerLabel === label) {
      last.text = `${last.text} ${text}`.trim();
      last.endMs = endSec * 1000;
    } else {
      turns.push({
        speakerLabel: label,
        text,
        startMs: word.start * 1000,
        endMs: endSec * 1000,
      });
    }
  }
  return turns;
}
