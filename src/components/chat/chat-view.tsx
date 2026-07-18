import * as React from "react";
import { ChatComposer } from "@/components/chat/chat-composer";
import { MessageBubble } from "@/components/chat/message-bubble";
import { EngineChip } from "@/components/shared/engine-chip";
import { useVoiceChat } from "@/lib/audio/use-voice-chat";
import { cloneTtsWarm } from "@/lib/engines/local";
import { useChatStream } from "@/lib/llm/use-chat-stream";
import { useMessagePlayback } from "@/lib/llm/use-message-playback";
import { useChatStore } from "@/stores/chat-store";
import { useSettingsStore } from "@/stores/settings-store";

// Voice-chat conversation view, text-chat first (spec M4 item 2): header with
// per-conversation model picker, message history, streamed reply, composer.
// Read-aloud (per-message play button) lands separately.

interface ChatViewProps {
  conversationId: string;
}

export function ChatView({ conversationId }: ChatViewProps) {
  const conversation = useChatStore((s) => s.conversations[conversationId]);
  const loadConversation = useChatStore((s) => s.loadConversation);
  const updateConversation = useChatStore((s) => s.updateConversation);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    void loadConversation(conversationId);
  }, [conversationId, loadConversation]);

  const { send, stop, isStreaming, pendingReply, error } = useChatStream(conversationId);
  const playback = useMessagePlayback(conversation?.voiceId);
  const inputMode = conversation?.voiceInputMode ?? "vad";
  const vadSilenceMs = useSettingsStore((s) => s.voiceChat.vadSilenceMs);
  const voiceChat = useVoiceChat({
    voiceId: conversation?.voiceId,
    ttsEnabled: conversation?.ttsEnabled ?? false,
    inputMode,
    vadSilenceMs,
    send,
    stopStream: stop,
  });

  // Warm ZipVoice when the conversation speaks in a local clone voice (M5
  // item 4): the ~0.5 s engine load happens on open instead of on the first
  // sentence, keeping time-to-first-audio under the 1.5 s target. Failures
  // are ignored — synthesis will surface the real error if it comes to that.
  const voiceId = conversation?.voiceId;
  React.useEffect(() => {
    if (voiceId?.startsWith("clone:zipvoice:")) {
      cloneTtsWarm().catch(() => {});
    }
  }, [voiceId]);

  const messageCount = conversation?.messages.length ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: messageCount/pendingReply are re-run triggers for scroll-to-bottom, not values read by the effect
  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messageCount, pendingReply]);

  // Auto-read the reply once a streaming turn finishes, when the
  // conversation has read-aloud enabled (spec M4 item 2: `ttsEnabled`).
  // Skipped while voice chat is active — it already speaks the reply
  // sentence-by-sentence through its own playback queue as it streams;
  // playing the full message again here would double it up.
  const prevStreamingRef = React.useRef(isStreaming);
  React.useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isStreaming;
    if (!wasStreaming || isStreaming) return;
    if (voiceChat.active) return;
    if (!conversation?.ttsEnabled) return;
    const last = conversation.messages[conversation.messages.length - 1];
    if (last?.role === "assistant" && !last.error && last.content) {
      playback.play(last.id, last.content);
    }
  }, [isStreaming, voiceChat.active, conversation?.ttsEnabled, conversation?.messages, playback.play]);

  if (!conversation) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Loading chat…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border px-2 py-2">
        <h1 className="truncate text-sm font-medium">{conversation.title}</h1>
        {voiceChat.active && <EngineChip task="batchAsr" />}
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-3xl space-y-4">
          {conversation.messages.length === 0 && !isStreaming ? (
            <p className="text-muted-foreground text-sm">Say something to get started.</p>
          ) : (
            conversation.messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                playbackStatus={playback.activeId === message.id ? playback.status : "idle"}
                onToggleSpeech={() => playback.play(message.id, message.content)}
                speechError={playback.activeId === message.id ? playback.error : null}
              />
            ))
          )}
          {isStreaming && (
            <MessageBubble
              message={{ id: "streaming", role: "assistant", content: pendingReply }}
              streaming
            />
          )}
        </div>
      </div>

      {error && (
        <p className="border-destructive/30 border-t bg-destructive/10 px-4 py-2 text-destructive text-xs">
          {error}
        </p>
      )}

      <ChatComposer
        isStreaming={isStreaming}
        onSend={(text) => void send(text)}
        onStop={stop}
        modelRef={conversation.modelRef}
        onModelChange={(ref) => void updateConversation(conversationId, { modelRef: ref })}
        voiceId={conversation.voiceId}
        onVoiceChange={(voiceId) => void updateConversation(conversationId, { voiceId })}
        voiceChatActive={voiceChat.active}
        onToggleVoiceChat={() => void (voiceChat.active ? voiceChat.stop() : voiceChat.start())}
        voiceChatStatus={voiceChat.status}
        voiceChatError={voiceChat.error}
        voiceInputMode={inputMode}
        onVoiceInputModeChange={(mode) =>
          void updateConversation(conversationId, { voiceInputMode: mode })
        }
        onPttDown={voiceChat.pttDown}
        onPttUp={voiceChat.pttUp}
        ttsEnabled={conversation.ttsEnabled}
        onToggleTts={() =>
          void updateConversation(conversationId, { ttsEnabled: !conversation.ttsEnabled })
        }
      />
    </div>
  );
}
