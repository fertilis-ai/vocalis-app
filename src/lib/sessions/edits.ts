import type { SpeakerRef, Transcript } from "@/lib/schemas/session";

// Pure session-edit operations (spec §2.2B, M3 item 5): rename a speaker, assign
// one to a Person, merge two speakers, and hand-edit a segment's text. Each
// returns new data; the view persists it via the session store.

/** Set (or clear, when blank) a speaker's display-name override. */
export function renameSpeaker(
  speakers: SpeakerRef[],
  label: string,
  name: string,
): SpeakerRef[] {
  const trimmed = name.trim();
  return speakers.map((s) =>
    s.label === label ? { ...s, name: trimmed || undefined } : s,
  );
}

/** Assign a speaker to a Person (null clears the assignment). */
export function assignPerson(
  speakers: SpeakerRef[],
  label: string,
  personId: string | null,
): SpeakerRef[] {
  return speakers.map((s) =>
    s.label === label ? { ...s, personId: personId ?? undefined } : s,
  );
}

/** Re-label every segment of `fromLabel` to `toLabel` (merging two speakers). */
export function reassignSpeaker(
  transcript: Transcript,
  fromLabel: string,
  toLabel: string,
): Transcript {
  return transcript.map((seg) =>
    seg.speakerLabel === fromLabel ? { ...seg, speakerLabel: toLabel } : seg,
  );
}

/** Replace a segment's text, marking it hand-edited. */
export function editSegmentText(
  transcript: Transcript,
  segmentId: string,
  text: string,
): Transcript {
  return transcript.map((seg) =>
    seg.id === segmentId ? { ...seg, text, edited: true } : seg,
  );
}
