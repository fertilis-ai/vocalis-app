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
// needs no key. Cloud entries stay visible but disabled with a reason
// (privacy mode / no API key) rather than disappearing, mirroring the
// EngineChip convention (spec M4 item 1: "reflect it in the model picker's
// disabled reasons").

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

// Shared across every mounted picker (chat header + Voice Chat settings), so
// one live fetch per key-set serves them all. An empty result isn't cached,
// so a transient failure retries on the next mount.
const liveModelsCache = new Map<string, Promise<ProviderModel[]>>();

function fetchLiveModels(keySignature: string, apiKeys: Record<string, string>) {
  let pending = liveModelsCache.get(keySignature);
  if (!pending) {
    pending = fetchAllProviderModels(apiKeys).then((results) => {
      const models = results.flatMap((r) => r.models);
      if (models.length === 0) liveModelsCache.delete(keySignature);
      return models;
    });
    liveModelsCache.set(keySignature, pending);
  }
  return pending;
}

export function ModelPicker({ value, onChange }: ModelPickerProps) {
  const apiKeys = useSettingsStore((s) => s.apiKeys);
  const localLLM = useSettingsStore((s) => s.localLLM);
  const privacyMode = useSettingsStore((s) => s.privacyMode);
  const [liveModels, setLiveModels] = useState<ProviderModel[] | null>(null);
  const keySignature = CLOUD_PROVIDERS.map((p) => (apiKeys[p] ? "1" : "0")).join("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on keySignature instead of the apiKeys object so a re-render with unchanged keys doesn't refetch
  useEffect(() => {
    // Every cloud entry is disabled under privacy mode — don't spend network
    // refining a list that can't be picked from anyway.
    if (privacyMode) return;
    let cancelled = false;
    void fetchLiveModels(keySignature, apiKeys).then((models) => {
      if (!cancelled && models.length > 0) setLiveModels(models);
    });
    return () => {
      cancelled = true;
    };
  }, [keySignature, privacyMode]);

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
          const disabledReason = privacyMode
            ? "privacy mode"
            : !apiKeys[provider]
              ? "no API key"
              : null;
          return (
            <DropdownMenuGroup key={provider}>
              <DropdownMenuLabel>{PROVIDER_LABELS[provider]}</DropdownMenuLabel>
              {models.map((m) => (
                <DropdownMenuItem
                  key={`${provider}/${m.id}`}
                  disabled={!!disabledReason}
                  onClick={() => onChange(`${provider}/${m.id}`)}
                >
                  <span className="flex-1 truncate">{m.name}</span>
                  {disabledReason && (
                    <span className="text-muted-foreground text-xs">{disabledReason}</span>
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
