import { createModels, type Context } from "@earendil-works/pi-ai";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

const POLISH_TIMEOUT_MS = 950;

function configuredModel(value: string): { provider: "openai" | "groq"; model: string } | null {
  const [provider, ...modelParts] = value.trim().split("/");
  const model = modelParts.join("/");
  if ((provider === "openai" || provider === "groq") && model) return { provider, model };
  return null;
}

/**
 * Lightweight text-only cleanup. Audio has already been transcribed locally;
 * this function is deliberately never called in privacy mode and falls back
 * to its input for missing credentials, a timeout, or provider failure.
 */
export async function polishDictation(
  text: string,
  options: { privacyMode: boolean; model: string; apiKeys: Record<string, string> },
): Promise<string> {
  if (!text.trim() || options.privacyMode) return text;
  const selected = configuredModel(options.model);
  if (!selected) return text;
  const apiKey = options.apiKeys[selected.provider];
  if (!apiKey) return text;

  const models = createModels();
  models.setProvider(selected.provider === "openai" ? openaiProvider() : groqProvider());
  const model = models.getModel(selected.provider, selected.model);
  if (!model) return text;

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), POLISH_TIMEOUT_MS);
  const context: Context = {
    systemPrompt:
      "Polish a dictated note. Remove filler and apply self-corrections, but preserve meaning, names, numbers, and tone. Return only the revised text. Do not add commentary.",
    messages: [{ role: "user", content: text, timestamp: Date.now() }],
  };
  try {
    const response = await models.completeSimple(model, context, {
      apiKey,
      maxTokens: 160,
      signal: controller.signal,
      temperature: 0,
      timeoutMs: POLISH_TIMEOUT_MS,
    });
    const polished = response.content
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("")
      .trim();
    return polished || text;
  } catch {
    return text;
  } finally {
    window.clearTimeout(timeout);
  }
}
