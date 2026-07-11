import { Waves } from "lucide-react";
import { useState } from "react";
import { ModelPicker } from "@/components/chat/model-picker";
import { VoicePicker } from "@/components/chat/voice-picker";
import { Checkbox } from "@/components/ui/checkbox";
import { useSettingsStore } from "@/stores/settings-store";
import { SettingsSection } from "./settings-section";

// Voice Chat settings (M4 item 4): VAD silence threshold, barge-in
// (display-only — capture now pauses during playback, so there's nothing to
// interrupt), and the default voice/model prefilled onto new voice-chat
// conversations (chat-sidebar.tsx's createChatLeaf). No shadcn Slider exists
// in this codebase, so the silence-threshold control is a raw range input.

const MIN_SILENCE_MS = 300;
const MAX_SILENCE_MS = 2000;
const STEP_MS = 50;

export function VoiceChatSettings() {
  const voiceChat = useSettingsStore((state) => state.voiceChat);
  const setVoiceChat = useSettingsStore((state) => state.setVoiceChat);
  // Track the drag locally and commit to the store on release — every store
  // write persists the whole settings state and re-renders all voiceChat
  // subscribers, which is too much per slider tick.
  const [draftSilenceMs, setDraftSilenceMs] = useState<number | null>(null);
  const commitSilenceMs = () => {
    if (draftSilenceMs === null) return;
    setVoiceChat({ vadSilenceMs: draftSilenceMs });
    setDraftSilenceMs(null);
  };
  const silenceMs = draftSilenceMs ?? voiceChat.vadSilenceMs;

  return (
    <SettingsSection icon={Waves} id="voice-chat" title="Voice Chat">
      <div className="space-y-6">
        <div>
          <label className="font-medium text-sm" htmlFor="vad-silence-ms">
            VAD silence threshold
          </label>
          <div className="mt-2 flex items-center gap-3">
            <input
              className="flex-1 accent-primary"
              id="vad-silence-ms"
              max={MAX_SILENCE_MS}
              min={MIN_SILENCE_MS}
              onBlur={commitSilenceMs}
              onChange={(event) => setDraftSilenceMs(Number(event.target.value))}
              onKeyUp={commitSilenceMs}
              onPointerUp={commitSilenceMs}
              step={STEP_MS}
              type="range"
              value={silenceMs}
            />
            <span className="w-16 shrink-0 text-right text-muted-foreground text-sm">
              {silenceMs} ms
            </span>
          </div>
          <p className="mt-2 text-muted-foreground text-xs">
            How long the mic must go quiet before a hands-free turn ends and sends to the model.
          </p>
        </div>

        <label className="flex items-center gap-3 text-sm opacity-70">
          <Checkbox checked={voiceChat.bargeInEnabled} disabled />
          <span>
            Barge-in: interrupt the assistant's reply as soon as you start speaking.
            <span className="block text-muted-foreground text-xs">
              Not available — the mic now pauses while the assistant is speaking, so there's
              nothing to interrupt with.
            </span>
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-4">
          <div>
            <span className="font-medium text-sm">Default voice</span>
            <div className="mt-2">
              <VoicePicker
                value={voiceChat.defaultVoiceId || undefined}
                onChange={(voiceId) => setVoiceChat({ defaultVoiceId: voiceId })}
              />
            </div>
          </div>
          <div>
            <span className="font-medium text-sm">Default model</span>
            <div className="mt-2">
              <ModelPicker
                value={voiceChat.defaultModelRef || undefined}
                onChange={(ref) => setVoiceChat({ defaultModelRef: ref })}
              />
            </div>
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          Applied to new conversations; existing conversations keep their own picks.
        </p>
      </div>
    </SettingsSection>
  );
}
