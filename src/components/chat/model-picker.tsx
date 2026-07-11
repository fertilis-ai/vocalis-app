import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CLOUD_PROVIDERS,
  type CloudProvider,
  MODEL_OPTIONS,
  type ProviderModel,
} from "@/lib/llm/models";
import { fetchAllProviderModels } from "@/lib/llm/provider-models";
import { useSettingsStore } from "@/stores/settings-store";

// Per-conversation model picker (spec M4 item 1). Static MODEL_OPTIONS shows
// immediately; a live fetch (keyed to which providers have a key set)
// refines the list once it lands. The local LLM entry always shows, since it
// needs no key.

const PROVIDER_LABELS: Record<CloudProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  openrouter: "OpenRouter",
};

interface ModelPickerProps {
  /** "provider/modelId", e.g. "anthropic/claude-sonnet-4-5" */
  value?: string;
  onChange: (ref: string) => void;
}

export function ModelPicker({ value, onChange }: ModelPickerProps) {
  const apiKeys = useSettingsStore((s) => s.apiKeys);
  const localLLM = useSettingsStore((s) => s.localLLM);
  const [liveModels, setLiveModels] = useState<ProviderModel[] | null>(null);
  const keySignature = CLOUD_PROVIDERS.map((p) => (apiKeys[p] ? "1" : "0")).join("");

  useEffect(() => {
    let cancelled = false;
    fetchAllProviderModels(apiKeys).then((results) => {
      if (cancelled) return;
      const models = results.flatMap((r) => r.models);
      if (models.length > 0) setLiveModels(models);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keySignature]);

  const modelsByProvider = useMemo(() => {
    const source = liveModels ?? MODEL_OPTIONS;
    const map = new Map<string, ProviderModel[]>();
    for (const m of source) {
      const list = map.get(m.provider) ?? [];
      list.push(m);
      map.set(m.provider, list);
    }
    return map;
  }, [liveModels]);

  const localLabel = localLLM.provider === "ollama" ? "Ollama" : "LM Studio";
  const localModelId = localLLM.model.trim() || "auto-detect";
  const localRef = `${localLLM.provider}/${localLLM.model.trim() || "auto"}`;

  const selectedLabel = useMemo(() => {
    if (!value) return "Choose a model";
    if (value.startsWith(`${localLLM.provider}/`)) return `${localLabel} · ${localModelId}`;
    const idx = value.indexOf("/");
    const provider = idx === -1 ? value : value.slice(0, idx);
    const modelId = idx === -1 ? "" : value.slice(idx + 1);
    const found = (modelsByProvider.get(provider) ?? []).find((m) => m.id === modelId);
    const providerLabel = PROVIDER_LABELS[provider as CloudProvider] ?? provider;
    return found ? `${providerLabel} · ${found.name}` : `${providerLabel} · ${modelId}`;
  }, [value, modelsByProvider, localLLM.provider, localLabel, localModelId]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
        <span className="max-w-48 truncate">{selectedLabel}</span>
        <ChevronDown className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuItem onClick={() => onChange(localRef)}>
          {localLabel} (local) · {localModelId}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {CLOUD_PROVIDERS.map((provider) => {
          const models = modelsByProvider.get(provider) ?? [];
          if (models.length === 0) return null;
          return (
            <DropdownMenuGroup key={provider}>
              <DropdownMenuLabel>{PROVIDER_LABELS[provider]}</DropdownMenuLabel>
              {models.map((m) => (
                <DropdownMenuItem key={`${provider}/${m.id}`} onClick={() => onChange(`${provider}/${m.id}`)}>
                  {m.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
