import { z } from "zod";

// Voice chat conversations (spec M4 item 2). One conversation is a single
// file ~/.vocalis/chats/<id>.json holding metadata plus the full message
// history — unlike sessions, chat transcripts are small enough that one file
// suffices (no separate transcript.json). The sidebar tree (which
// conversations exist, in what folders) is owned by the collection store;
// chat-store.ts owns each conversation's content.

export const chatMessageSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: z.string().datetime(),
  /** Set when the assistant turn ended in an error; content holds whatever streamed before it. */
  error: z.string().optional(),
});

export const conversationSchema = z.object({
  id: z.string().uuid(),
  type: z.literal("llm"),
  title: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
  /** TTS speaker/voice id for read-aloud; unset = engine default. */
  voiceId: z.string().optional(),
  /** "provider/model", e.g. "anthropic/claude-sonnet-4-5". Unset = no model chosen yet. */
  modelRef: z.string().optional(),
  /** Whether new assistant replies auto-play as speech. */
  ttsEnabled: z.boolean(),
  messages: z.array(chatMessageSchema),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
