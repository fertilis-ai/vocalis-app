// Chat model catalog + provider routing (spec M4 item 1). Trimmed from
// Sapio's models.ts: only the four cloud providers Vocalis exposes API keys
// for (api-keys-settings.tsx) plus local Ollama/LM Studio (settings-store's
// localLLM). MODEL_OPTIONS is a static fallback shown before (or without) a
// live fetch via provider-models.ts.

export interface ProviderModel {
  id: string;
  name: string;
  provider: string;
}

export const CLOUD_PROVIDERS = ["anthropic", "openai", "google", "openrouter"] as const;
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

export const LOCAL_PROVIDERS = ["ollama", "lmstudio"] as const;
export type LocalProvider = (typeof LOCAL_PROVIDERS)[number];

export const MODEL_OPTIONS: ProviderModel[] = [
  { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5", provider: "anthropic" },
  { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku", provider: "anthropic" },
  { id: "gpt-4o", name: "GPT-4o", provider: "openai" },
  { id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai" },
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", provider: "google" },
  { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", provider: "openrouter" },
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "openrouter" },
];

export const DEFAULT_MODEL_REF = "anthropic/claude-sonnet-4-5-20250929";

/** Maps a cloud provider to the pi-ai API its models stream over. */
export const PROVIDER_API_MAP: Record<CloudProvider, string> = {
  anthropic: "anthropic-messages",
  openai: "openai-completions",
  google: "google-generative-ai",
  openrouter: "openai-completions",
};

export const PROVIDER_BASE_URLS: Record<CloudProvider, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  openrouter: "https://openrouter.ai/api/v1",
};

export function isCloudProvider(provider: string): provider is CloudProvider {
  return (CLOUD_PROVIDERS as readonly string[]).includes(provider);
}

export function isLocalProvider(provider: string): provider is LocalProvider {
  return (LOCAL_PROVIDERS as readonly string[]).includes(provider);
}

/** Split a "provider/model" ref; the model id may itself contain slashes (e.g. OpenRouter). */
export function parseModelRef(ref: string): { provider: string; modelId: string } | null {
  const idx = ref.indexOf("/");
  if (idx <= 0 || idx === ref.length - 1) return null;
  return { provider: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}

export function getActiveModels(selected?: ProviderModel[]): ProviderModel[] {
  return selected && selected.length > 0 ? selected : MODEL_OPTIONS;
}
