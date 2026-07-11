import { create } from "zustand";
import { type ChatMessage, type Conversation, conversationSchema } from "@/lib/schemas/chat";
import { deletePath, readFile, writeFile } from "@/lib/storage";
import { serialize } from "@/lib/write-queue";

// Owns ~/.vocalis/chats/<id>.json (spec §4, M4 item 2) — one file per
// conversation, metadata plus the full message history. The sidebar tree
// (which conversations exist, in what folders) is owned by the collection
// store (chats-collection.ts); this store owns each conversation's content.
// State mirrors disk.

export function chatPath(id: string): string {
  return `~/.vocalis/chats/${id}.json`;
}

export interface NewConversation {
  id: string;
  title: string;
  voiceId?: string;
  modelRef?: string;
}

interface ChatState {
  /** conversation id -> loaded conversation */
  conversations: Record<string, Conversation>;
  /**
   * Conversation ids whose file existed but failed to parse/validate. A
   * backup was written to `<id>.json.bak`; further writes are refused for
   * that id until the app is restarted (after the file is fixed or removed)
   * so nothing overwrites the quarantined original.
   */
  corrupt: Record<string, boolean>;

  loadConversation: (id: string) => Promise<Conversation | null>;
  createConversation: (init: NewConversation) => Promise<Conversation>;
  updateConversation: (id: string, patch: Partial<Conversation>) => Promise<Conversation | null>;
  appendMessage: (id: string, message: ChatMessage) => Promise<Conversation | null>;
  updateMessage: (
    id: string,
    messageId: string,
    patch: Partial<ChatMessage>,
  ) => Promise<Conversation | null>;
  /** Delete the conversation file. */
  removeConversation: (id: string) => Promise<void>;
}

export const useChatStore = create<ChatState>()((set, get) => {
  // Serialized per conversation id so two overlapping mutations (e.g. a
  // streamed token append racing a title rename) can't both read the same
  // stale `current` and have one clobber the other's write (spec M8).
  function withConversation(
    id: string,
    mutate: (current: Conversation) => Conversation,
  ): Promise<Conversation | null> {
    return serialize(`chat:${id}`, async () => {
      if (get().corrupt[id]) {
        throw new Error(
          `${chatPath(id)} was corrupt and has been backed up to ${chatPath(id)}.bak. ` +
            "Fix or remove it and restart the app before saving this conversation again.",
        );
      }
      const current = get().conversations[id] ?? (await get().loadConversation(id));
      if (!current) return null;
      const next = mutate(current);
      await writeFile(chatPath(id), JSON.stringify(next, null, 2));
      set((s) => ({ conversations: { ...s.conversations, [id]: next } }));
      return next;
    });
  }

  return {
    conversations: {},
    corrupt: {},

    loadConversation: async (id) => {
      const cached = get().conversations[id];
      if (cached) return cached;
      let raw: string;
      try {
        raw = await readFile(chatPath(id));
      } catch {
        return null;
      }
      if (!raw) return null;
      try {
        const conversation = conversationSchema.parse(JSON.parse(raw));
        set((s) => ({ conversations: { ...s.conversations, [id]: conversation } }));
        return conversation;
      } catch (err) {
        console.error(`[chat] corrupt conversation ${id}, quarantining:`, err);
        await writeFile(`${chatPath(id)}.bak`, raw).catch(() => {});
        set((s) => ({ corrupt: { ...s.corrupt, [id]: true } }));
        return null;
      }
    },

    createConversation: async (init) => {
      const conversation: Conversation = {
        id: init.id,
        type: "llm",
        title: init.title,
        createdAt: new Date().toISOString(),
        voiceId: init.voiceId,
        modelRef: init.modelRef,
        ttsEnabled: false,
        messages: [],
      };
      await writeFile(chatPath(conversation.id), JSON.stringify(conversation, null, 2));
      set((s) => ({ conversations: { ...s.conversations, [conversation.id]: conversation } }));
      return conversation;
    },

    updateConversation: (id, patch) =>
      withConversation(id, (current) => ({
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      })),

    appendMessage: (id, message) =>
      withConversation(id, (current) => ({
        ...current,
        messages: [...current.messages, message],
        updatedAt: new Date().toISOString(),
      })),

    updateMessage: (id, messageId, patch) =>
      withConversation(id, (current) => ({
        ...current,
        messages: current.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m)),
        updatedAt: new Date().toISOString(),
      })),

    removeConversation: async (id) => {
      await deletePath(chatPath(id));
      set((s) => {
        const conversations = { ...s.conversations };
        const corrupt = { ...s.corrupt };
        delete conversations[id];
        delete corrupt[id];
        return { conversations, corrupt };
      });
    },
  };
});
