import { z } from "zod";

export const dictationHistoryEntrySchema = z.object({
  id: z.string().uuid(),
  text: z.string().min(1),
  createdAt: z.string().datetime(),
});

export const dictationHistorySchema = z.array(dictationHistoryEntrySchema).max(50);

export type DictationHistoryEntry = z.infer<typeof dictationHistoryEntrySchema>;
