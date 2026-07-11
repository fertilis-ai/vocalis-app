import { Volume2, VolumeX } from "lucide-react";
import * as React from "react";
import { ChatComposer } from "@/components/chat/chat-composer";
import { MessageBubble } from "@/components/chat/message-bubble";
import { ModelPicker } from "@/components/chat/model-picker";
import { Button } from "@/components/ui/button";
import { useChatStream } from "@/lib/llm/use-chat-stream";
import { useMessagePlayback } from "@/lib/llm/use-message-playback";
import { useChatStore } from "@/stores/chat-store";

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

  const messageCount = conversation?.messages.length ?? 0;
  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messageCount, pendingReply]);

  // Auto-read the reply once a streaming turn finishes, when the
  // conversation has read-aloud enabled (spec M4 item 2: `ttsEnabled`).
  const prevStreamingRef = React.useRef(isStreaming);
  React.useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isStreaming;
    if (!wasStreaming || isStreaming) return;
    if (!conversation?.ttsEnabled) return;
    const last = conversation.messages[conversation.messages.length - 1];
    if (last?.role === "assistant" && !last.error && last.content) {
      playback.play(last.id, last.content);
    }
  }, [isStreaming, conversation?.ttsEnabled, conversation?.messages, playback.play]);

  if (!conversation) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Loading chat…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-3 border-border border-b px-4 py-3">
        <h1 className="truncate font-semibold text-base">{conversation.title}</h1>
        <div className="flex items-center gap-2">
          <Button
            size="icon"
            variant="ghost"
            onClick={() =>
              void updateConversation(conversationId, { ttsEnabled: !conversation.ttsEnabled })
            }
            aria-label={
              conversation.ttsEnabled ? "Disable auto read-aloud" : "Enable auto read-aloud"
            }
          >
            {conversation.ttsEnabled ? (
              <Volume2 className="h-4 w-4" />
            ) : (
              <VolumeX className="h-4 w-4" />
            )}
          </Button>
          <ModelPicker
            value={conversation.modelRef}
            onChange={(ref) => void updateConversation(conversationId, { modelRef: ref })}
          />
        </div>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
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

      {error && (
        <p className="border-destructive/30 border-t bg-destructive/10 px-4 py-2 text-destructive text-xs">
          {error}
        </p>
      )}

      <ChatComposer isStreaming={isStreaming} onSend={(text) => void send(text)} onStop={stop} />
    </div>
  );
}
