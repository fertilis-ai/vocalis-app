import { Keyboard } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { loadDictationHistory } from "@/lib/dictation/history";
import type { DictationHistoryEntry } from "@/lib/schemas/dictation-history";
import { useSettingsStore } from "@/stores/settings-store";
import { SettingsSection } from "./settings-section";

function hotkeyFromEvent(event: React.KeyboardEvent<HTMLInputElement>): string | null {
  const key = event.code === "Space" ? "Space" : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  if (["Control", "Alt", "Meta", "Shift"].includes(key)) return null;
  const modifiers = [
    event.ctrlKey && "Control",
    event.altKey && "Alt",
    event.shiftKey && "Shift",
    event.metaKey && "Super",
  ].filter(Boolean);
  return [...modifiers, key].join("+");
}

export function DictationSettings() {
  const dictation = useSettingsStore((state) => state.dictation);
  const setDictation = useSettingsStore((state) => state.setDictation);
  const [history, setHistory] = useState<DictationHistoryEntry[]>([]);

  useEffect(() => {
    void loadDictationHistory().then(setHistory);
  }, []);

  return (
    <SettingsSection icon={Keyboard} id="dictation" title="Dictation">
      <div className="space-y-6">
        <div>
          <label className="font-medium text-sm" htmlFor="dictation-hotkey">
            Global hotkey
          </label>
          <div className="mt-2">
            <Input
              id="dictation-hotkey"
              onChange={(event) => setDictation({ hotkey: event.target.value })}
              onKeyDown={(event) => {
                const shortcut = hotkeyFromEvent(event);
                if (shortcut) {
                  event.preventDefault();
                  setDictation({ hotkey: shortcut });
                }
              }}
              value={dictation.hotkey}
            />
          </div>
          <p className="mt-2 text-muted-foreground text-xs">
            Focus this field and press your preferred combination.
          </p>
        </div>

        <div>
          <span className="font-medium text-sm">Activation</span>
          <div className="mt-2 flex gap-2">
            {(["hold", "toggle"] as const).map((mode) => (
              <Button
                className="capitalize"
                key={mode}
                onClick={() => setDictation({ mode })}
                variant={dictation.mode === mode ? "secondary" : "outline"}
              >
                {mode}
              </Button>
            ))}
          </div>
          <p className="mt-2 text-muted-foreground text-xs">
            Hold dictates while the key is down; toggle starts and stops on each press.
          </p>
        </div>

        <div className="space-y-4">
          <span className="font-medium text-sm">Polish</span>
          <label className="flex cursor-pointer items-center gap-3 text-sm">
            <Checkbox
              checked={dictation.polish}
              onCheckedChange={(checked) => setDictation({ polish: checked === true })}
            />
            Lightly clean up filler words and self-corrections after dictation.
          </label>
          <div>
            <label className="font-medium text-sm" htmlFor="polish-model">
              Polish model
            </label>
            <div className="mt-2">
              <Input
                id="polish-model"
                list="polish-model-options"
                onChange={(event) => setDictation({ polishModel: event.target.value })}
                placeholder="Choose a configured provider model"
                value={dictation.polishModel}
              />
              <datalist id="polish-model-options">
                <option value="openai/gpt-4o-mini">OpenAI · GPT-4o mini</option>
                <option value="groq/llama-3.1-8b-instant">Groq · Llama 3.1 8B Instant</option>
              </datalist>
            </div>
            <p className="mt-2 text-muted-foreground text-xs">
              Requires an API key for the provider; skipped in privacy mode.
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <span className="font-medium text-sm">Text history</span>
          <label className="flex cursor-pointer items-center gap-3 text-sm">
            <Checkbox
              checked={dictation.historyEnabled}
              onCheckedChange={(checked) => setDictation({ historyEnabled: checked === true })}
            />
            Save the last 50 successfully copied dictations. Audio is never saved.
          </label>
          {dictation.historyEnabled && (
            <div className="max-h-56 divide-y overflow-auto rounded-lg border border-border">
              {history.length === 0 ? (
                <p className="p-4 text-muted-foreground text-sm">No successful dictations yet.</p>
              ) : (
                history.map((entry) => (
                  <article className="space-y-1 p-3" key={entry.id}>
                    <p className="text-sm">{entry.text}</p>
                    <time className="text-muted-foreground text-xs">
                      {new Date(entry.createdAt).toLocaleString()}
                    </time>
                  </article>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}
