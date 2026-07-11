import type { Session, Transcript } from "@/lib/schemas/session";

// Pure transcript formatters (spec §2.2B, M3 item 5). Each takes the session
// metadata, its segments, and a label→display-name resolver (so speaker naming
// stays owned by the UI's SpeakerRef/People resolution) and returns a string.
// No fs here — writing + revealing lives in export-session.ts.

export type ExportFormat = "markdown" | "srt" | "json";

/** label → display name (e.g. "A" → "Alice" / "Speaker A"). */
export type NameResolver = (label: string) => string;

export const EXPORT_EXTENSION: Record<ExportFormat, string> = {
  markdown: "md",
  srt: "srt",
  json: "json",
};

/** Milliseconds → "HH:MM:SS,mmm" (SRT timing). */
export function msToSrtTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const h = Math.floor(clamped / 3_600_000);
  const m = Math.floor((clamped % 3_600_000) / 60_000);
  const s = Math.floor((clamped % 60_000) / 1000);
  const millis = clamped % 1000;
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(millis, 3)}`;
}

/** Milliseconds → "M:SS" / "H:MM:SS" for compact display. */
export function msToClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Markdown: title + metadata, then one paragraph per speaker turn. */
export function formatMarkdown(
  session: Session,
  transcript: Transcript,
  nameFor: NameResolver,
): string {
  const lines: string[] = [`# ${session.title || "Session"}`, ""];
  const meta: string[] = [new Date(session.createdAt).toLocaleString()];
  if (session.durationMs) meta.push(msToClock(session.durationMs));
  if (session.engineId) meta.push(session.engineId);
  lines.push(`_${meta.join(" · ")}_`, "");

  if (transcript.length === 0) {
    lines.push("_(no speech)_");
    return `${lines.join("\n")}\n`;
  }

  for (const seg of transcript) {
    lines.push(
      `**${nameFor(seg.speakerLabel)}** (${msToClock(seg.startMs)})`,
      seg.text.trim() || "…",
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** SubRip: one cue per segment, "HH:MM:SS,mmm" timing, speaker-prefixed. */
export function formatSrt(
  transcript: Transcript,
  nameFor: NameResolver,
): string {
  const cues = transcript.map((seg, i) => {
    const start = msToSrtTime(seg.startMs);
    // Guard against zero/negative-length cues so players don't drop them.
    const end = msToSrtTime(Math.max(seg.endMs, seg.startMs + 1));
    const speaker = nameFor(seg.speakerLabel);
    const text = seg.text.trim() || "…";
    return `${i + 1}\n${start} --> ${end}\n${speaker}: ${text}`;
  });
  return `${cues.join("\n\n")}\n`;
}

/** JSON: full metadata + segments with timing, speaker, and resolved name. */
export function formatJson(
  session: Session,
  transcript: Transcript,
  nameFor: NameResolver,
): string {
  const payload = {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    mode: session.mode,
    engineId: session.engineId,
    durationMs: session.durationMs,
    speakers: session.speakers.map((s) => ({
      label: s.label,
      name: nameFor(s.label),
      personId: s.personId,
    })),
    segments: transcript.map((seg) => ({
      speakerLabel: seg.speakerLabel,
      speaker: nameFor(seg.speakerLabel),
      personId: seg.personId,
      text: seg.text,
      startMs: seg.startMs,
      endMs: seg.endMs,
      confidence: seg.confidence,
    })),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** Format a session's transcript in the requested format. */
export function formatTranscript(
  format: ExportFormat,
  session: Session,
  transcript: Transcript,
  nameFor: NameResolver,
): string {
  switch (format) {
    case "markdown":
      return formatMarkdown(session, transcript, nameFor);
    case "srt":
      return formatSrt(transcript, nameFor);
    case "json":
      return formatJson(session, transcript, nameFor);
  }
}
