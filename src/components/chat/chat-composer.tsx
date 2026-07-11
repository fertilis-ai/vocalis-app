import { ArrowUp, Square } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface ChatComposerProps {
  disabled?: boolean;
  isStreaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}

export function ChatComposer({ disabled, isStreaming, onSend, onStop }: ChatComposerProps) {
  const [value, setValue] = React.useState("");

  function submit() {
    const text = value.trim();
    if (!text || isStreaming) return;
    onSend(text);
    setValue("");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="flex items-end gap-2 border-border border-t p-3">
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Message…"
        rows={2}
        disabled={disabled}
        className="max-h-40 min-h-16 flex-1 resize-none"
      />
      {isStreaming ? (
        <Button size="icon" variant="outline" onClick={onStop} aria-label="Stop">
          <Square className="h-3.5 w-3.5 fill-current" />
        </Button>
      ) : (
        <Button size="icon" onClick={submit} disabled={disabled || !value.trim()} aria-label="Send">
          <ArrowUp className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
