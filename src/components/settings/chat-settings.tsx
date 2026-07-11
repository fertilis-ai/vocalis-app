import { MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LOCAL_PROVIDERS, type LocalProvider } from "@/lib/llm/models";
import { useSettingsStore } from "@/stores/settings-store";
import { SettingsSection } from "./settings-section";

const LOCAL_PROVIDER_LABELS: Record<LocalProvider, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
};

const DEFAULT_BASE_URLS: Record<LocalProvider, string> = {
  ollama: "http://localhost:11434",
  lmstudio: "http://localhost:1234",
};

export function ChatSettings() {
  const localLLM = useSettingsStore((state) => state.localLLM);
  const setLocalLLM = useSettingsStore((state) => state.setLocalLLM);

  return (
    <SettingsSection icon={MessageSquare} id="chat" title="Chat">
      <div className="space-y-6">
        <p className="text-muted-foreground text-sm">
          Voice and text chat pick a cloud model (using the keys above) or a local server per
          conversation. Local chat requires Ollama or LM Studio running and reachable.
        </p>

        <div className="space-y-4">
          <span className="font-medium text-sm">Local LLM server</span>
          <div className="flex gap-2">
            {LOCAL_PROVIDERS.map((provider) => (
              <Button
                key={provider}
                onClick={() =>
                  setLocalLLM({
                    provider,
                    baseUrl:
                      localLLM.baseUrl === DEFAULT_BASE_URLS[localLLM.provider]
                        ? DEFAULT_BASE_URLS[provider]
                        : localLLM.baseUrl,
                  })
                }
                variant={localLLM.provider === provider ? "secondary" : "outline"}
              >
                {LOCAL_PROVIDER_LABELS[provider]}
              </Button>
            ))}
          </div>

          <div>
            <label className="font-medium text-sm" htmlFor="local-llm-base-url">
              Base URL
            </label>
            <div className="mt-2">
              <Input
                id="local-llm-base-url"
                onChange={(event) => setLocalLLM({ baseUrl: event.target.value })}
                placeholder={DEFAULT_BASE_URLS[localLLM.provider]}
                value={localLLM.baseUrl}
              />
            </div>
          </div>

          <div>
            <label className="font-medium text-sm" htmlFor="local-llm-model">
              Model
            </label>
            <div className="mt-2">
              <Input
                id="local-llm-model"
                onChange={(event) => setLocalLLM({ model: event.target.value })}
                placeholder="Leave blank to auto-detect"
                value={localLLM.model}
              />
            </div>
            <p className="mt-2 text-muted-foreground text-xs">
              Blank uses the first model the server reports at chat time.
            </p>
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}
