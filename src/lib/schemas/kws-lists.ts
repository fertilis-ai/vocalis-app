import { z } from "zod";

// Saved keyword lists for the KWS playground tool, persisted at
// ~/.vocalis/playground/kws/lists.json. sherpa's spotter needs BPE-tokenized
// keywords (one per line), so `keywords` holds the raw tokenized text exactly
// as passed to the engine.

export const kwsListSchema = z.object({
  name: z.string().min(1),
  /** Tokenized keyword lines, newline-joined (engine input verbatim). */
  keywords: z.string(),
});

export const kwsListsFileSchema = z.object({
  lists: z.array(kwsListSchema),
});

export type KwsList = z.infer<typeof kwsListSchema>;

export const KWS_LISTS_PATH = "~/.vocalis/playground/kws/lists.json";
