import { ArrowUp, ChevronDown, Mic, MicOff, Radio, Square, Volume2, VolumeX } from "lucide-react";
import * as React from "react";
import { ModelPicker } from "@/components/chat/model-picker";
import { VoicePicker } from "@/components/chat/voice-picker";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import type { VoiceChatStatus, VoiceInputMode } from "@/lib/audio/use-voice-chat";
import { cn } from "@/lib/utils";

const VOICE_STATUS_LABEL: Record<VoiceChatStatus, string> = {
  idle: "Starting…",
  listening: "Listening…",
  userSpeaking: "Listening…",
  transcribing: "Transcribing…",
  thinking: "Thinking…",
  speaking: "Speaking…",
};

interface ChatComposerProps {
  disabled?: boolean;
  isStreaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  modelRef?: string;
  onModelChange: (ref: string) => void;
  voiceId?: string;
  onVoiceChange: (voiceId: string) => void;
  voiceChatActive: boolean;
  onToggleVoiceChat: () => void;
  voiceChatStatus: VoiceChatStatus;
  voiceChatError: string | null;
  voiceInputMode: VoiceInputMode;
  onVoiceInputModeChange: (mode: VoiceInputMode) => void;
  onPttDown: () => void;
  onPttUp: () => void;
  ttsEnabled: boolean;
  onToggleTts: () => void;
}

export function ChatComposer({
  disabled,
  isStreaming,
  onSend,
  onStop,
  modelRef,
  onModelChange,
  voiceId,
  onVoiceChange,
  voiceChatActive,
  onToggleVoiceChat,
  voiceChatStatus,
  voiceChatError,
  voiceInputMode,
  onVoiceInputModeChange,
  onPttDown,
  onPttUp,
  ttsEnabled,
  onToggleTts,
}: ChatComposerProps) {
  const [value, setValue] = React.useState("");
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  function adjustHeight() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }

  function submit() {
    const text = value.trim();
    if (!text || isStreaming) return;
    onSend(text);
    setValue("");
    requestAnimationFrame(adjustHeight);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-4">
      <div className="rounded-2xl border border-border bg-muted/30">
        <div className="px-4 pt-3 pb-2">
          {voiceChatActive ? (
            <p
              className={cn(
                "min-h-6 truncate text-sm",
                voiceChatError ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {voiceChatError || VOICE_STATUS_LABEL[voiceChatStatus]}
            </p>
          ) : (
            <Textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                adjustHeight();
              }}
              onKeyDown={onKeyDown}
              placeholder="Message…"
              rows={1}
              disabled={disabled}
              className="min-h-6 max-h-[200px] resize-none border-0 bg-transparent p-0 text-sm shadow-none outline-none focus-visible:ring-0"
            />
          )}
        </div>
        <div className="flex items-center justify-between gap-1 border-border/50 border-t px-2 py-1">
          <div className="flex items-center gap-1">
            <ModelPicker value={modelRef} onChange={onModelChange} />
            <VoicePicker value={voiceId} onChange={onVoiceChange} />
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="sm" />}>
                {voiceInputMode === "ptt" ? "Push to talk" : "Hands-free"}
                <ChevronDown className="h-3.5 w-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={() => onVoiceInputModeChange("vad")}>
                  Hands-free
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onVoiceInputModeChange("ptt")}>
                  Push to talk
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 rounded-lg"
              onClick={onToggleTts}
              aria-label={ttsEnabled ? "Disable auto read-aloud" : "Enable auto read-aloud"}
            >
              {ttsEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
            </Button>
            <Button
              size="icon"
              variant={voiceChatActive ? "default" : "ghost"}
              className="h-7 w-7 rounded-lg"
              onClick={onToggleVoiceChat}
              aria-label={voiceChatActive ? "Stop voice chat" : "Start voice chat"}
            >
              {voiceChatActive ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
            </Button>
            {voiceChatActive && voiceInputMode === "ptt" && (
              <Button
                size="icon"
                variant={voiceChatStatus === "userSpeaking" ? "default" : "outline"}
                className="h-7 w-7 rounded-lg"
                onMouseDown={onPttDown}
                onMouseUp={onPttUp}
                onMouseLeave={onPttUp}
                onTouchStart={onPttDown}
                onTouchEnd={onPttUp}
                aria-label="Hold to talk"
              >
                <Radio className="h-4 w-4" />
              </Button>
            )}
            {isStreaming ? (
              <Button
                size="icon"
                variant="destructive"
                className="h-7 w-7 rounded-lg"
                onClick={onStop}
                aria-label="Stop"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
              </Button>
            ) : (
              <Button
                size="icon"
                variant={value.trim() ? "default" : "ghost"}
                className="h-7 w-7 rounded-lg"
                onClick={submit}
                disabled={disabled || voiceChatActive || !value.trim()}
                aria-label="Send"
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
