import { ELEVENLABS_DEFAULT_VOICE } from "@/lib/engines/elevenlabs";
import { ttsSynthesize } from "@/lib/engines/local";
import { type SynthTarget, synthesizeWithTarget } from "@/lib/engines/port";
import { findEngine } from "@/lib/engines/descriptors";
import {
  evaluateEngine,
  REASON_LABELS,
  resolveEngine,
  type RouterContext,
} from "@/lib/routing/engine-router";
import {
  MAX_SPEECH_INPUT_CHARS,
  stripMarkdownForSpeech,
} from "@/lib/llm/strip-markdown-for-speech";
import { personDir, usePeopleStore } from "@/stores/people-store";
import { useVoicesStore } from "@/stores/voices-store";

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
 * Synthesize already-speech-ready text (no markdown stripping). Clone voices
 * (voiceId "clone:zipvoice:<personId>" / "clone:elevenlabs:<personId>", M5)
 * dispatch to the cloneTts engine the voice belongs to — a clone voice is
 * bound to its engine, so an ineligible engine is an error, never a reroute.
 * Other voices resolve through the `tts` task router — likewise never a
 * silent local→API fallback. `voiceId` is the conversation's picked voice
 * (sherpa speaker id for local, provider voice id for API); unset falls back
 * to the engine default.
 */
export async function synthesizeSpeech(
  input: string,
  ctx: RouterContext,
  apiKeys: Record<string, string>,
  voiceId?: string,
): Promise<{ path: string }> {
  if (voiceId?.startsWith("clone:")) {
    const target = await resolveCloneTarget(voiceId, ctx);
    // Clone voice ids double as voice-library ids — honor the per-voice
    // default speed (spec §3.5 TtsVoice.params).
    await useVoicesStore.getState().load();
    const speed = useVoicesStore.getState().voices[voiceId]?.params.speed;
    const res = await synthesizeWithTarget(target, input, { apiKeys, speed });
    return { path: res.path };
  }

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

/**
 * Resolve a stored clone voice id into its synth target, enforcing the
 * engine's eligibility (privacy mode hard-blocks the ElevenLabs clone; a
 * missing clone-tts model blocks ZipVoice) — spec §3.4's no-fallback rule.
 */
async function resolveCloneTarget(
  voiceId: string,
  ctx: RouterContext,
): Promise<SynthTarget> {
  const [, engineKind, personId] = voiceId.split(":");
  const engineId = engineKind === "zipvoice" ? "local.zipvoice" : "elevenlabs.clone";
  const engine = findEngine("cloneTts", engineId);
  if (!engine) throw new Error(`Unknown clone voice "${voiceId}".`);
  const { eligible, reason } = evaluateEngine(engine, ctx);
  if (!eligible) {
    throw new Error(
      `${engine.label} is unavailable${reason ? ` (${REASON_LABELS[reason]})` : ""}.`,
    );
  }

  const peopleStore = usePeopleStore.getState();
  await peopleStore.loadAll();
  const person = usePeopleStore.getState().people[personId];
  if (!person) throw new Error("The cloned voice's person profile is missing.");

  if (engineKind === "zipvoice") {
    const clone = person.clones.zipvoice;
    if (!clone) throw new Error(`${person.name} has no local clone reference.`);
    return {
      kind: "clone-local",
      refAudio: `${personDir(person.id)}/${clone.refAudio}`,
      refText: clone.refText,
    };
  }
  const clone = person.clones.elevenlabs;
  if (!clone) throw new Error(`${person.name} has no ElevenLabs clone.`);
  return { kind: "clone-api", provider: "elevenlabs", voiceId: clone.voiceId };
}
