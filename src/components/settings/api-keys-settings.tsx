import { KeyRound } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";
import { SettingsSection } from "./settings-section";

// Speech providers (spec decision 4) plus the LLM providers the polish pass
// and voice chat use. Keys go straight to the macOS keychain (service
// "Vocalis") via the settings store's write-through — never to disk.
const PROVIDERS = [
  { id: "openai", label: "OpenAI", hint: "batch transcription, TTS, polish/chat models" },
  { id: "anthropic", label: "Anthropic", hint: "chat and polish models" },
  { id: "groq", label: "Groq", hint: "fast Whisper transcription, polish models" },
  { id: "elevenlabs", label: "ElevenLabs", hint: "TTS, Scribe, instant voice clones" },
  { id: "deepgram", label: "Deepgram", hint: "streaming transcription, diarization" },
  { id: "google", label: "Google", hint: "chat models" },
  { id: "openrouter", label: "OpenRouter", hint: "chat models" },
] as const;

function ProviderKeyRow({ id, label, hint }: (typeof PROVIDERS)[number]) {
  const stored = useSettingsStore((s) => s.apiKeys[id] ?? "");
  const setApiKey = useSettingsStore((s) => s.setApiKey);
  const [draft, setDraft] = useState<string | null>(null);
  const dirty = draft !== null && draft !== stored;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "h-2 w-2 rounded-full",
            stored ? "bg-green-500" : "bg-muted-foreground/30",
          )}
          title={stored ? "key stored" : "no key"}
        />
        <label className="font-medium text-sm" htmlFor={`api-key-${id}`}>
          {label}
        </label>
        <span className="text-muted-foreground text-xs">{hint}</span>
      </div>
      <div className="flex gap-2">
        <Input
          autoComplete="off"
          id={`api-key-${id}`}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={stored ? "••••••••••••" : "Paste API key"}
          type="password"
          value={draft ?? stored}
        />
        {dirty && (
          <Button
            onClick={() => {
              setApiKey(id, (draft ?? "").trim());
              setDraft(null);
            }}
          >
            Save
          </Button>
        )}
        {!dirty && stored && (
          <Button
            onClick={() => {
              setApiKey(id, "");
              setDraft(null);
            }}
            variant="outline"
          >
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}

export function ApiKeysSettings() {
  return (
    <SettingsSection icon={KeyRound} id="api-keys" title="API Keys">
      <div className="space-y-5">
        <p className="text-muted-foreground text-sm">
          Keys are stored in the macOS keychain, never in files. Providers without a key
          simply stay unavailable in engine pickers.
        </p>
        {PROVIDERS.map((provider) => (
          <ProviderKeyRow key={provider.id} {...provider} />
        ))}
      </div>
    </SettingsSection>
  );
}
