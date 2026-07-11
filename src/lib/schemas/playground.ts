import { z } from "zod";

// One persisted bench run (spec §2.3/§4): params + result + input reference,
// written to ~/.vocalis/playground/<tool>/runs/<id>.json. `result` stays
// task-shaped (each tool renders its own results panel), so it is validated
// only as JSON here.

export const runInputSchema = z.object({
  kind: z.enum(["mic", "file", "library", "text"]),
  /** Audio inputs: absolute path to the wav (mic clips live in recordings/bench) */
  path: z.string().optional(),
  /** Display name (file basename, or a text snippet) */
  name: z.string().optional(),
  /** Text inputs (punctuation, TTS) */
  text: z.string().optional(),
});

export const playgroundRunSchema = z.object({
  id: z.string().uuid(),
  tool: z.string().min(1),
  /** Engine descriptor id that served the run (null = none resolved) */
  engineId: z.string().nullable(),
  createdAt: z.string().datetime(),
  /** Wall-clock time the run took */
  durationMs: z.number().nonnegative(),
  input: runInputSchema,
  params: z.record(z.string(), z.unknown()),
  result: z.unknown(),
});

export type RunInput = z.infer<typeof runInputSchema>;
export type PlaygroundRun = z.infer<typeof playgroundRunSchema>;

/** Recent runs kept per tool — oldest beyond this are deleted from disk. */
export const MAX_RUNS_PER_TOOL = 20;
