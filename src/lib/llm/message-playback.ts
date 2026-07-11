import { ELEVENLABS_DEFAULT_VOICE } from "@/lib/engines/elevenlabs";
import { ttsSynthesize } from "@/lib/engines/local";
import { synthesizeWithTarget } from "@/lib/engines/port";
import { resolveEngine, type RouterContext } from "@/lib/routing/engine-router";
import {
  MAX_SPEECH_INPUT_CHARS,
  stripMarkdownForSpeech,
} from "@/lib/llm/strip-markdown-for-speech";

const OPENAI_DEFAULT_VOICE = "alloy";

/**
 * Synthesize one chat message for read-aloud (spec M4 item 2): strips markdown
 * and clamps length, then synthesizes via `synthesizeSpeech`. Callers that
 * already prepared the text (the voice-chat playback queue strips per
 * sentence) use `synthesizeSpeech` directly instead, so the strip runs once.
 */
export async function synthesizeMessageSpeech(
  text: string,
  ctx: RouterContext,
  apiKeys: Record<string, string>,
  voiceId?: string,
): Promise<{ path: string }> {
  const input = stripMarkdownForSpeech(text).slice(0, MAX_SPEECH_INPUT_CHARS);
  if (!input) throw new Error("Nothing to read aloud.");
  return synthesizeSpeech(input, ctx, apiKeys, voiceId);
}

/**
 * Synthesize already-speech-ready text (no markdown stripping). Resolves the
 * active engine through the `tts` task router — never a silent local→API
 * fallback — then dispatches to the local or API synth path. `voiceId` is the
 * conversation's picked voice (sherpa speaker id for local, provider voice id
 * for API); unset falls back to the engine default.
 */
export async function synthesizeSpeech(
  input: string,
  ctx: RouterContext,
  apiKeys: Record<string, string>,
  voiceId?: string,
): Promise<{ path: string }> {
  const engine = resolveEngine("tts", ctx).active;
  if (!engine) throw new Error("No text-to-speech engine is available for read-aloud.");

  if (engine.kind === "local") {
    const sid = voiceId !== undefined ? Number(voiceId) : undefined;
    const res = await ttsSynthesize(input, {
      speakerId: sid !== undefined && Number.isFinite(sid) ? sid : undefined,
    });
    return { path: res.path };
  }

  if (engine.provider !== "openai" && engine.provider !== "elevenlabs") {
    throw new Error(`${engine.label} does not support read-aloud yet.`);
  }
  const voice =
    voiceId ?? (engine.provider === "openai" ? OPENAI_DEFAULT_VOICE : ELEVENLABS_DEFAULT_VOICE);
  const res = await synthesizeWithTarget(
    { kind: "api", provider: engine.provider, voice },
    input,
    { apiKeys },
  );
  return { path: res.path };
}
