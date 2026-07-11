import { useCallback, useRef, useState } from "react";
import { v4 as uuid } from "uuid";
import { autoTitle } from "@/lib/llm/chat-title";
import { streamChat } from "@/lib/llm/stream-chat";
import type { ChatMessage, Conversation } from "@/lib/schemas/chat";
import { useChatStore } from "@/stores/chat-store";
import { useChatsCollection } from "@/stores/chats-collection";
import { useSettingsStore } from "@/stores/settings-store";

// Drives one conversation's text-chat turn (spec M4 item 2): persist the user
// message, stream the reply, persist the finished (or stopped) assistant
// message. Token-by-token deltas stay in local state — writing every delta to
// disk would hammer the write queue — the store only sees one write per turn.

export interface UseChatStreamResult {
  /** `onDelta` additionally receives each raw token as it streams — voice
   * mode feeds it into a sentence chunker; text chat leaves it unset. */
  send: (text: string, onDelta?: (delta: string) => void) => Promise<void>;
  stop: () => void;
  isStreaming: boolean;
  pendingReply: string;
  error: string | null;
}

export function useChatStream(conversationId: string): UseChatStreamResult {
  const [pendingReply, setPendingReply] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const streamingRef = useRef(false);

  const send = useCallback(
    async (text: string, onDelta?: (delta: string) => void) => {
      const trimmed = text.trim();
      if (!trimmed || streamingRef.current) return;
      setError(null);

      const chatStore = useChatStore.getState();
      const before = chatStore.conversations[conversationId];
      const isFirstTurn = !before || before.messages.length === 0;

      const userMessage: ChatMessage = {
        id: uuid(),
        role: "user",
        content: trimmed,
        createdAt: new Date().toISOString(),
      };

      let updated: Conversation | null;
      try {
        updated = await chatStore.appendMessage(conversationId, userMessage);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save message.");
        return;
      }
      if (!updated) return;

      if (isFirstTurn) {
        const title = autoTitle(trimmed);
        chatStore.updateConversation(conversationId, { title }).catch(() => {});
        useChatsCollection
          .getState()
          .rename(conversationId, title)
          .catch(() => {});
      }

      const controller = new AbortController();
      abortRef.current = controller;
      streamingRef.current = true;
      setIsStreaming(true);
      setPendingReply("");

      const settings = useSettingsStore.getState();
      let accumulated = "";
      let streamError: string | null = null;
      try {
        for await (const delta of streamChat({
          conversation: updated,
          privacyMode: settings.privacyMode,
          apiKeys: settings.apiKeys,
          localLLM: settings.localLLM,
          signal: controller.signal,
        })) {
          accumulated += delta;
          setPendingReply(accumulated);
          onDelta?.(delta);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          streamError = err instanceof Error ? err.message : "Chat request failed.";
        }
      }
      abortRef.current = null;

      if (accumulated.trim()) {
        await chatStore
          .appendMessage(conversationId, {
            id: uuid(),
            role: "assistant",
            content: accumulated,
            createdAt: new Date().toISOString(),
            error: streamError ?? undefined,
          })
          .catch(() => {});
      } else if (streamError) {
        setError(streamError);
      }

      streamingRef.current = false;
      setIsStreaming(false);
      setPendingReply("");
    },
    [conversationId],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { send, stop, isStreaming, pendingReply, error };
}
