import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple as streamAnthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamGoogleGenerativeAi } from "@earendil-works/pi-ai/api/google-generative-ai";
import { streamSimple as streamOpenAiCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { platformFetch } from "@/lib/engines/http";
import { messagesToPiMessages } from "@/lib/llm/message-conversion";
import {
  type CloudProvider,
  type LocalProvider,
  PROVIDER_API_MAP,
  PROVIDER_BASE_URLS,
  isCloudProvider,
  isLocalProvider,
  parseModelRef,
} from "@/lib/llm/models";
import type { Conversation } from "@/lib/schemas/chat";

// Chat streaming (spec M4 item 1). Extracted from Sapio's chat-store.ts
// web-only-mode branches: build a plain pi-ai `Model` object per provider
// (cloud or local) and stream against the matching `api/*` module directly —
// no tool-calling, no adapter, no Models registry. Privacy mode is enforced
// once, here: unlike dictation-polish.ts (API-only, always skipped under
// privacy mode), chat has a local option, so only cloud providers are barred.

export interface LocalLlmSettings {
  provider: LocalProvider;
  baseUrl: string;
  /** Explicit model name; empty = auto-detect the server's first available model. */
  model: string;
}

function buildOpenAiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) return trimmed;
  const v1Idx = trimmed.indexOf("/v1/");
  if (v1Idx !== -1) return trimmed.slice(0, v1Idx + 3);
  return `${trimmed}/v1`;
}

async function resolveLocalModelId(local: LocalLlmSettings): Promise<string | null> {
  if (local.model.trim()) return local.model.trim();
  const fetchImpl = platformFetch();
  try {
    const resp = await fetchImpl(`${buildOpenAiBaseUrl(local.baseUrl)}/models`);
    if (resp.ok) {
      const data = (await resp.json()) as { data?: Array<{ id?: string }> };
      const id = data?.data?.[0]?.id;
      if (id) return id;
    }
  } catch {
    // fall through to the Ollama-native probe below
  }
  if (local.provider === "ollama") {
    try {
      const resp = await fetchImpl(`${local.baseUrl.trim().replace(/\/+$/, "")}/api/tags`);
      if (!resp.ok) return null;
      const data = (await resp.json()) as { models?: Array<{ name?: string }> };
      return data?.models?.[0]?.name ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

function buildLocalModel(local: LocalLlmSettings, modelId: string): Model<"openai-completions"> {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: local.provider,
    baseUrl: buildOpenAiBaseUrl(local.baseUrl),
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 32_000,
  };
}

function buildCloudModel(provider: CloudProvider, modelId: string, apiKey: string): Model<Api> {
  const model: Model<Api> = {
    id: modelId,
    name: modelId,
    api: PROVIDER_API_MAP[provider],
    provider,
    baseUrl: PROVIDER_BASE_URLS[provider],
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
  // OpenRouter proxies to an upstream provider via redirect; Tauri's fetch
  // can drop the Authorization header across that hop, so send it explicitly
  // rather than relying on the SDK's own auth plumbing.
  if (provider === "openrouter") {
    model.headers = { Authorization: `Bearer ${apiKey}` };
    model.compat = { supportsStore: false, supportsDeveloperRole: false };
  }
  return model;
}

async function resolveModel(params: {
  provider: string;
  modelId: string;
  apiKey?: string;
  localLLM?: LocalLlmSettings;
}): Promise<{ model: Model<Api>; apiKey: string }> {
  if (isLocalProvider(params.provider)) {
    if (!params.localLLM) throw new Error("Local LLM is not configured.");
    const modelId = await resolveLocalModelId(params.localLLM);
    if (!modelId) {
      throw new Error("No local model found. Configure a model name or check your local server.");
    }
    return { model: buildLocalModel(params.localLLM, modelId), apiKey: "local" };
  }
  if (!isCloudProvider(params.provider)) {
    throw new Error(`Unknown chat provider: ${params.provider}`);
  }
  if (!params.apiKey) {
    throw new Error(`No API key set for ${params.provider}. Add one in Settings.`);
  }
  return {
    model: buildCloudModel(params.provider, params.modelId, params.apiKey),
    apiKey: params.apiKey,
  };
}

function streamForApi(model: Model<Api>, context: Context, options: SimpleStreamOptions) {
  switch (model.api) {
    case "anthropic-messages":
      return streamAnthropicMessages(model as Model<"anthropic-messages">, context, options);
    case "google-generative-ai":
      return streamGoogleGenerativeAi(model as Model<"google-generative-ai">, context, options);
    case "openai-completions":
      return streamOpenAiCompletions(model as Model<"openai-completions">, context, options);
    default:
      throw new Error(`Unsupported chat API: ${model.api}`);
  }
}

export interface StreamChatParams {
  /** Conversation whose `messages` end with the user turn to answer (no trailing assistant placeholder). */
  conversation: Conversation;
  systemPrompt?: string;
  privacyMode: boolean;
  apiKeys: Record<string, string>;
  localLLM?: LocalLlmSettings;
  temperature?: number;
  signal?: AbortSignal;
}

/** Streams assistant text deltas for one turn. Throws on privacy mode, missing config, or a provider error. */
export async function* streamChat(params: StreamChatParams): AsyncGenerator<string, void, void> {
  const ref = params.conversation.modelRef ? parseModelRef(params.conversation.modelRef) : null;
  if (!ref) {
    throw new Error("No model selected for this conversation.");
  }
  if (params.privacyMode && !isLocalProvider(ref.provider)) {
    throw new Error("Only local models (Ollama/LM Studio) are available in privacy mode.");
  }

  const { model, apiKey } = await resolveModel({
    provider: ref.provider,
    modelId: ref.modelId,
    apiKey: params.apiKeys[ref.provider],
    localLLM: params.localLLM,
  });

  const context: Context = {
    systemPrompt: params.systemPrompt,
    messages: messagesToPiMessages(params.conversation.messages, model.api, model.provider, model.id),
  };

  const stream = streamForApi(model, context, {
    apiKey,
    temperature: params.temperature,
    signal: params.signal,
  });

  for await (const event of stream) {
    if (event.type === "text_delta") {
      yield event.delta;
    } else if (event.type === "error") {
      throw new Error(event.error.errorMessage || "Chat request failed.");
    }
  }
}
