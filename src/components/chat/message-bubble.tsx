import { AlertTriangle, Loader2, Play, Square } from "lucide-react";
import type { PlaybackStatus } from "@/lib/llm/use-message-playback";
import type { ChatMessage } from "@/lib/schemas/chat";
import { isDesktop } from "@/lib/storage";
import { cn } from "@/lib/utils";

interface MessageBubbleProps {
  message: Pick<ChatMessage, "id" | "role" | "content" | "error">;
  /** Trailing cursor for a reply that's still streaming in. */
  streaming?: boolean;
  /** Read-aloud status for this message; omit to hide the play button. */
  playbackStatus?: PlaybackStatus;
  onToggleSpeech?: () => void;
  speechError?: string | null;
}

export function MessageBubble({
  message,
  streaming,
  playbackStatus,
  onToggleSpeech,
  speechError,
}: MessageBubbleProps) {
  const isUser = message.role === "user";
  const showPlayback = !isUser && !streaming && message.content && isDesktop() && onToggleSpeech;
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[75%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm",
          isUser ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
        )}
      >
        {message.content}
        {streaming && <span className="ml-0.5 inline-block animate-pulse">▍</span>}
        {showPlayback && (
          <div className="mt-1.5 flex items-center gap-1.5">
            <button
              type="button"
              onClick={onToggleSpeech}
              aria-label={playbackStatus === "playing" ? "Stop reading aloud" : "Read aloud"}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              {playbackStatus === "loading" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : playbackStatus === "playing" ? (
                <Square className="h-3 w-3 fill-current" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
            </button>
            {speechError && <span className="text-destructive text-xs">{speechError}</span>}
          </div>
        )}
        {message.error && (
          <p className="mt-1.5 flex items-center gap-1 text-destructive text-xs">
            <AlertTriangle className="h-3 w-3 flex-shrink-0" />
            {message.error}
          </p>
        )}
      </div>
    </div>
  );
}
