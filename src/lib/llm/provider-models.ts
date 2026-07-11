import { platformFetch } from "@/lib/engines/http";
import type { CloudProvider, ProviderModel } from "@/lib/llm/models";

// Live model-list fetchers for the LLM Models settings section (spec M4
// item 1). Trimmed from Sapio's provider-models.ts: chat models only, no
// image/transcription/speech fetchers (Vocalis's speech models come from the
// M2 engine registry, not these providers).

export interface FetchModelsResult {
  provider: CloudProvider;
  models: ProviderModel[];
  error?: string;
}

/** Prefixes/substrings that identify an OpenAI *chat* model, not TTS/embedding/etc. */
const OPENAI_CHAT_PREFIXES = ["gpt-", "o1-", "o3-", "o4-", "chatgpt-"];
const OPENAI_EXCLUDE_PATTERNS = ["-realtime-", "-audio-", "-search-"];
const OPENAI_EXCLUDE_PREFIXES = ["embedding", "whisper", "tts", "dall-e", "moderation", "text-embedding"];

function isOpenAiChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  if (OPENAI_EXCLUDE_PATTERNS.some((p) => lower.includes(p))) return false;
  if (OPENAI_EXCLUDE_PREFIXES.some((p) => lower.startsWith(p))) return false;
  return OPENAI_CHAT_PREFIXES.some((p) => lower.startsWith(p));
}

async function readErrorBody(resp: Response): Promise<string> {
  try {
    const body = await resp.text();
    try {
      const json = JSON.parse(body) as { error?: { message?: string }; message?: string };
      const msg = json.error?.message ?? json.message;
      if (msg) return `HTTP ${resp.status}: ${msg}`;
    } catch {
      // not JSON
    }
    if (body.length > 0 && body.length < 200) return `HTTP ${resp.status}: ${body}`;
  } catch {
    // body unreadable — status alone is enough
  }
  return `HTTP ${resp.status}`;
}

async function fetchAnthropic(apiKey: string): Promise<FetchModelsResult> {
  try {
    const resp = await platformFetch()("https://api.anthropic.com/v1/models?limit=1000", {
      headers: {
        "x-api-key": apiKey.trim(),
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
    });
    if (!resp.ok) return { provider: "anthropic", models: [], error: await readErrorBody(resp) };
    const data = (await resp.json()) as { data?: Array<{ id: string; display_name?: string }> };
    const models: ProviderModel[] = (data.data ?? []).map((m) => ({
      id: m.id,
      name: m.display_name ?? m.id,
      provider: "anthropic",
    }));
    return { provider: "anthropic", models };
  } catch (e) {
    return { provider: "anthropic", models: [], error: String(e) };
  }
}

async function fetchOpenAI(apiKey: string): Promise<FetchModelsResult> {
  try {
    const resp = await platformFetch()("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
    });
    if (!resp.ok) return { provider: "openai", models: [], error: await readErrorBody(resp) };
    const data = (await resp.json()) as { data?: Array<{ id: string }> };
    const models: ProviderModel[] = (data.data ?? [])
      .filter((m) => isOpenAiChatModel(m.id))
      .map((m) => ({ id: m.id, name: m.id, provider: "openai" }));
    return { provider: "openai", models };
  } catch (e) {
    return { provider: "openai", models: [], error: String(e) };
  }
}

async function fetchGoogle(apiKey: string): Promise<FetchModelsResult> {
  try {
    const resp = await platformFetch()(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey.trim()}&pageSize=1000`,
    );
    if (!resp.ok) return { provider: "google", models: [], error: await readErrorBody(resp) };
    const data = (await resp.json()) as {
      models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }>;
    };
    const models: ProviderModel[] = (data.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => ({
        id: m.name.replace(/^models\//, ""),
        name: m.displayName ?? m.name.replace(/^models\//, ""),
        provider: "google",
      }));
    return { provider: "google", models };
  } catch (e) {
    return { provider: "google", models: [], error: String(e) };
  }
}

function isTextModel(architecture?: { input_modalities?: string[]; output_modalities?: string[] }): boolean {
  if (!architecture) return true;
  const inputs = architecture.input_modalities;
  const outputs = architecture.output_modalities;
  if (outputs && (!outputs.includes("text") || outputs.includes("image") || outputs.includes("audio"))) {
    return false;
  }
  if (inputs && !inputs.includes("text")) return false;
  return true;
}

async function fetchOpenRouter(apiKey?: string): Promise<FetchModelsResult> {
  try {
    const headers: Record<string, string> = {};
    if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
    const resp = await platformFetch()("https://openrouter.ai/api/v1/models", { headers });
    if (!resp.ok) return { provider: "openrouter", models: [], error: await readErrorBody(resp) };
    const data = (await resp.json()) as {
      data?: Array<{
        id: string;
        name?: string;
        architecture?: { input_modalities?: string[]; output_modalities?: string[] };
      }>;
    };
    const models: ProviderModel[] = (data.data ?? [])
      .filter((m) => isTextModel(m.architecture))
      .map((m) => ({ id: m.id, name: m.name ?? m.id, provider: "openrouter" }));
    return { provider: "openrouter", models };
  } catch (e) {
    return { provider: "openrouter", models: [], error: String(e) };
  }
}

export async function fetchProviderModels(
  provider: CloudProvider,
  apiKey: string,
): Promise<FetchModelsResult> {
  switch (provider) {
    case "anthropic":
      return fetchAnthropic(apiKey);
    case "openai":
      return fetchOpenAI(apiKey);
    case "google":
      return fetchGoogle(apiKey);
    case "openrouter":
      return fetchOpenRouter(apiKey || undefined);
  }
}

export async function fetchAllProviderModels(
  apiKeys: Record<string, string>,
): Promise<FetchModelsResult[]> {
  const providers: CloudProvider[] = ["anthropic", "openai", "google", "openrouter"];
  const eligible = providers.filter((p) => p === "openrouter" || apiKeys[p]?.trim());
  return Promise.all(eligible.map((p) => fetchProviderModels(p, apiKeys[p] ?? "")));
}
