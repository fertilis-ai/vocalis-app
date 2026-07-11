import { z } from "zod";

// People / enrolled speakers (spec §2.4, §3.5, §4). One Person is a directory
// ~/.vocalis/people/<id>/ holding:
//   profile.json     — metadata below (personSchema)
//   enrollment/*.flac — enrollment clips
//   clone-ref/*.flac  — clone reference clips (M5)
//   embedding.bin     — averaged enrollment embedding, raw f32 little-endian
// The clone fields are included now so M5 does not have to migrate the schema.

/** A reference to an audio clip on disk (relative to the Person directory). */
export const audioRefSchema = z.object({
  /** Path relative to people/<id>/ (e.g. "enrollment/0.flac"). */
  path: z.string().min(1),
  durationMs: z.number().nonnegative().optional(),
});

/** Averaged enrollment embedding + the clips it was built from. */
export const enrollmentSchema = z.object({
  samples: z.array(audioRefSchema),
  /** Path (relative to people/<id>/) to raw f32 little-endian embedding. */
  embeddingPath: z.string().min(1),
  /** Vector length; needed to read embedding.bin back. */
  embeddingDim: z.number().int().positive(),
  enrolledAt: z.string().datetime(),
});

/** Clone consent bundle (M5): reference audio + its transcript. */
export const cloneRefSchema = z.object({
  samples: z.array(audioRefSchema),
  transcript: z.string(),
  consentConfirmed: z.literal(true),
});

/** Provider-specific clone handles (M5). */
export const clonesSchema = z.object({
  zipvoice: z
    .object({ refAudio: z.string(), refText: z.string() })
    .optional(),
  elevenlabs: z.object({ voiceId: z.string() }).optional(),
});

export const personSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  /** Avatar/label color (CSS value or chart token). */
  color: z.string(),
  createdAt: z.string().datetime(),
  /** null until the guided enrollment flow completes. */
  enrollment: enrollmentSchema.nullable().default(null),
  cloneRef: cloneRefSchema.optional(),
  clones: clonesSchema.default({}),
});

export type AudioRef = z.infer<typeof audioRefSchema>;
export type Enrollment = z.infer<typeof enrollmentSchema>;
export type CloneRef = z.infer<typeof cloneRefSchema>;
export type Person = z.infer<typeof personSchema>;
