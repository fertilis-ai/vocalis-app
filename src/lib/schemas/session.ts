import { z } from "zod";

// Transcription sessions (spec §2.2B, §3.5, §4). One session is a directory
// ~/.vocalis/sessions/<id>/ holding three files:
//   session.json    — metadata below (sessionSchema)
//   transcript.json — the ordered segments (transcriptSchema)
//   audio.flac      — retained capture (only when audioRetained)
// Kept as separate files so the transcript can grow/refine without rewriting
// metadata, and so audio can be discarded independently of the transcript.

/** A speaker in a session: the anonymous cluster label plus any naming. */
export const speakerRefSchema = z.object({
  /** Stable cluster label ("A", "B", …) from `speaker-labels.ts`. */
  label: z.string().min(1),
  /** Resolved enrolled Person, when matched or assigned. */
  personId: z.string().uuid().optional(),
  /** Custom display name overriding "Speaker A" / the Person name. */
  name: z.string().optional(),
  /** Explicit color override; otherwise derived from label order. */
  color: z.string().optional(),
});

export const transcriptSegmentSchema = z.object({
  id: z.string().uuid(),
  /** Ties the segment to a `SpeakerRef.label`. */
  speakerLabel: z.string().min(1),
  /** Denormalized Person match for quick rendering (mirrors the SpeakerRef). */
  personId: z.string().uuid().optional(),
  text: z.string(),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  /** ASR confidence 0–1 when the engine reports it. */
  confidence: z.number().min(0).max(1).optional(),
  /** True while the label came from online labeling (pre-refinement). */
  provisional: z.boolean().optional(),
  /** Set once a user hand-edits the text. */
  edited: z.boolean().optional(),
});

/** The transcript file is the ordered segment list. */
export const transcriptSchema = z.array(transcriptSegmentSchema);

export const sessionModeSchema = z.enum(["live", "import"]);

/**
 * Lifecycle: draft (created, not started) → recording → processing (stop-time
 * refinement) → complete; import → processing → complete. `error` is terminal.
 */
export const sessionStatusSchema = z.enum([
  "draft",
  "recording",
  "processing",
  "complete",
  "error",
]);

export const sessionSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
  mode: sessionModeSchema,
  /** Whether audio.flac is kept on disk (per-session retention toggle). */
  audioRetained: z.boolean(),
  /** Engine descriptor id that served the transcription (null = unresolved). */
  engineId: z.string().nullable(),
  speakers: z.array(speakerRefSchema),
  status: sessionStatusSchema,
  /** Total captured/imported duration once known. */
  durationMs: z.number().nonnegative().optional(),
  /** Human-facing message when status is "error". */
  error: z.string().optional(),
});

export type SpeakerRef = z.infer<typeof speakerRefSchema>;
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;
export type Transcript = z.infer<typeof transcriptSchema>;
export type SessionMode = z.infer<typeof sessionModeSchema>;
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type Session = z.infer<typeof sessionSchema>;
