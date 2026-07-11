import { v4 as uuid } from "uuid";
import type { Person } from "@/lib/schemas/people";
import type {
  SpeakerRef,
  Transcript,
  TranscriptSegment,
} from "@/lib/schemas/session";
import { speakerColor } from "@/lib/speaker-labels";
import { useSessionStore } from "@/stores/session-store";

// Shared turn → transcript mapping and speaker resolution for both session
// paths (live capture and file import). Pipeline turns arrive without ids or a
// display identity; the webview assigns uuids here and derives speaker names +
// colors from the session's SpeakerRefs and any matched People.

/** A raw pipeline turn (from the Rust `SessionSegment`, live or import). */
export interface RawTurn {
  speakerLabel: string;
  text: string;
  startMs: number;
  endMs: number;
  personId?: string | null;
}

/** Map raw pipeline turns into stored transcript segments (fresh uuids). */
export function toTranscript(turns: RawTurn[], provisional: boolean): Transcript {
  return turns.map((t) => ({
    id: uuid(),
    speakerLabel: t.speakerLabel,
    personId: t.personId ?? undefined,
    text: t.text,
    startMs: t.startMs,
    endMs: t.endMs,
    provisional,
  }));
}

/** Distinct speaker refs from segments, in order of first appearance. */
export function speakersOf(segments: TranscriptSegment[]): SpeakerRef[] {
  const refs: SpeakerRef[] = [];
  for (const seg of segments) {
    if (!refs.some((r) => r.label === seg.speakerLabel)) {
      refs.push({ label: seg.speakerLabel, personId: seg.personId });
    }
  }
  return refs;
}

/**
 * Merge a session's existing SpeakerRefs with those implied by a transcript,
 * preserving user edits (name/color/personId) on labels that persist. New
 * labels are appended in first-appearance order.
 */
export function mergeSpeakers(
  existing: SpeakerRef[],
  segments: TranscriptSegment[],
): SpeakerRef[] {
  const seen = speakersOf(segments);
  return seen.map((ref) => {
    const prior = existing.find((e) => e.label === ref.label);
    // Keep user naming/assignment; fall back to the segment's fresh personId.
    return prior ? { ...prior } : ref;
  });
}

/** Persist a transcript and refresh the session's derived speaker list. */
export async function persistTranscript(
  sessionId: string,
  transcript: Transcript,
): Promise<void> {
  const store = useSessionStore.getState();
  const session = store.sessions[sessionId] ?? (await store.loadSession(sessionId));
  await store.saveTranscript(sessionId, transcript);
  await store.updateSession(sessionId, {
    speakers: mergeSpeakers(session?.speakers ?? [], transcript),
  });
}

export interface SpeakerDisplay {
  name: string;
  color: string;
}

/**
 * Resolve a speaker label's display name and color: an explicit SpeakerRef
 * override wins, then a matched Person's name/color, then the default
 * "Speaker A" + palette color keyed by first-appearance order.
 */
export function speakerDisplay(
  label: string,
  speakers: SpeakerRef[],
  people: Record<string, Person>,
): SpeakerDisplay {
  const index = speakers.findIndex((s) => s.label === label);
  const ref = index >= 0 ? speakers[index] : undefined;
  const person = ref?.personId ? people[ref.personId] : undefined;
  return {
    name: ref?.name ?? person?.name ?? `Speaker ${label}`,
    color: ref?.color ?? person?.color ?? speakerColor(Math.max(0, index)),
  };
}
