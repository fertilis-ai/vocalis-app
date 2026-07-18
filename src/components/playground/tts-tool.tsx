import { Cloud, Download, Loader2, Play, Volume2, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RecentRuns } from "@/components/bench/recent-runs";
import { Waveform, type WaveformHandle } from "@/components/bench/waveform";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ttsSaveToLibrary } from "@/lib/engines/local";
import { synthesizeWithTarget, targetSupportsSpeed } from "@/lib/engines/port";
import {
  buildVoiceGroups,
  engineForTarget,
  type PickerGroup,
  type PickerVoice,
} from "@/lib/engines/tts-voices";
import type { PlaygroundRun } from "@/lib/schemas/playground";
import { isDesktop } from "@/lib/storage";
import { useModelsStore } from "@/stores/models-store";
import { usePeopleStore } from "@/stores/people-store";
import { usePlaygroundStore } from "@/stores/playground-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useVoicesStore } from "@/stores/voices-store";

const TOOL = "tts";

/** A completed synthesis, ready to render as a labelled waveform. */
interface SynthOutput {
  voiceKey: string;
  label: string;
  path: string;
  cached: boolean;
  synthMs: number;
}

export function TtsTool() {
  const installed = useModelsStore((s) => s.installed);
  const installedScanned = useModelsStore((s) => s.installedScanned);
  const loadInstalled = useModelsStore((s) => s.loadInstalled);
  const apiKeys = useSettingsStore((s) => s.apiKeys);
  const privacyMode = useSettingsStore((s) => s.privacyMode);
  const people = usePeopleStore((s) => s.people);
  const loadPeople = usePeopleStore((s) => s.loadAll);
  const library = useVoicesStore((s) => s.voices);
  const loadLibrary = useVoicesStore((s) => s.load);
  useEffect(() => {
    if (!installedScanned) void loadInstalled();
    void loadPeople();
    void loadLibrary();
  }, [installedScanned, loadInstalled, loadPeople, loadLibrary]);

  const groups = useMemo(
    () =>
      buildVoiceGroups(installed, apiKeys, privacyMode, {
        people: Object.values(people),
        library,
      }),
    [installed, apiKeys, privacyMode, people, library],
  );
  const voices = useMemo(() => groups.flatMap((g) => g.voices), [groups]);
  const voiceByKey = useCallback(
    (key: string) => voices.find((v) => v.key === key) ?? null,
    [voices],
  );

  const [text, setText] = useState(
    "Vocalis is running speech synthesis fully on this machine.",
  );
  const [speed, setSpeed] = useState(1.0);
  const [voiceA, setVoiceA] = useState<string>("");
  const [voiceB, setVoiceB] = useState<string>("");
  const [compare, setCompare] = useState(false);

  // The engine that will actually run — derived from the picked voice, not
  // the task router, since this page selects a voice directly (spec §3.4
  // routing is bypassed here).
  const activeEngine = useMemo(() => {
    const voice = voiceByKey(voiceA);
    return voice ? engineForTarget(voice.target) : undefined;
  }, [voiceA, voiceByKey]);

  // Some cloud voices ignore the speed multiplier entirely — disable the
  // control rather than send a value the engine silently drops.
  const speedSupported = useMemo(() => {
    const a = voiceByKey(voiceA);
    const b = compare ? voiceByKey(voiceB) : null;
    return [a, b].filter(Boolean).every((v) => targetSupportsSpeed((v as PickerVoice).target));
  }, [voiceA, voiceB, compare, voiceByKey]);

  const [outputs, setOutputs] = useState<SynthOutput[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const addRun = usePlaygroundStore((s) => s.addRun);

  // Seed / repair the voice selectors as the available voice set changes.
  useEffect(() => {
    if (voices.length === 0) return;
    setVoiceA((prev) => (voiceByKey(prev) ? prev : voices[0].key));
    setVoiceB((prev) =>
      voiceByKey(prev) ? prev : voices[Math.min(1, voices.length - 1)].key,
    );
  }, [voices, voiceByKey]);

  const synthOne = useCallback(
    async (voice: PickerVoice): Promise<SynthOutput> => {
      const res = await synthesizeWithTarget(voice.target, text, { apiKeys, speed });
      return {
        voiceKey: voice.key,
        label: voice.label,
        path: res.path,
        cached: res.cached,
        synthMs: res.processingMs,
      };
    },
    [text, speed, apiKeys],
  );

  const speak = useCallback(async () => {
    if (!text.trim() || busy) return;
    const a = voiceByKey(voiceA);
    const b = voiceByKey(voiceB);
    if (!a) return;
    setBusy(true);
    setError(null);
    setSavedNote(null);
    setSelectedRunId(null);
    const startedAt = performance.now();
    try {
      // Sequential: the Rust TTS engine is one shared instance and A/B often
      // spans two engines — parallelism would just serialize on the mutex.
      const results = [await synthOne(a)];
      if (compare && b && b.key !== a.key) results.push(await synthOne(b));
      setOutputs(results);
      await addRun({
        tool: TOOL,
        engineId: activeEngine?.id ?? null,
        durationMs: Math.round(performance.now() - startedAt),
        input: { kind: "text", text, name: text.slice(0, 60) },
        params: {
          voiceA: a.label,
          voiceB: compare && b ? b.label : undefined,
          speed,
        },
        result: results,
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [text, busy, voiceA, voiceB, voiceByKey, compare, synthOne, addRun, activeEngine, speed]);

  const save = useCallback(async (output: SynthOutput) => {
    try {
      const path = await ttsSaveToLibrary(output.path, output.label);
      setSavedNote(`Saved to library: ${path.split("/").pop()}`);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const restoreRun = useCallback((saved: PlaygroundRun) => {
    setText(saved.input.text ?? "");
    setOutputs((saved.result as SynthOutput[] | null) ?? []);
    setError(null);
    setSavedNote(null);
    setSelectedRunId(saved.id);
  }, []);

  const noVoices = installedScanned && voices.length === 0;

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-y-auto p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-semibold text-xl">Speech synthesis</h1>
          <p className="text-muted-foreground text-sm">
            Local & cloud multi-voice TTS, including cloned voices from People.
          </p>
        </div>
        <span className="flex items-center gap-1 rounded-full border border-border px-2 py-1 text-muted-foreground text-xs">
          {activeEngine?.kind === "api" ? (
            <Cloud className="h-3 w-3" />
          ) : (
            <Zap className="h-3 w-3" />
          )}
          {activeEngine?.label ?? "no voice selected"}
        </span>
      </header>

      {!isDesktop() && (
        <p className="text-muted-foreground text-sm">
          Local speech synthesis requires the desktop app.
        </p>
      )}
      {noVoices && (
        <p className="rounded-md border border-border bg-muted/40 p-3 text-muted-foreground text-sm">
          No TTS voices available — download Kokoro or a Piper voice in Models, or
          add an OpenAI / ElevenLabs key in Settings.
        </p>
      )}

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        className="w-full resize-y rounded-md border border-input bg-transparent p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        placeholder="Type something to speak…"
      />

      <div className="flex flex-wrap items-end gap-4">
        <VoiceSelect
          label={compare ? "Voice A" : "Voice"}
          groups={groups}
          value={voiceA}
          onChange={setVoiceA}
          disabled={busy}
        />
        {compare && (
          <VoiceSelect
            label="Voice B"
            groups={groups}
            value={voiceB}
            onChange={setVoiceB}
            disabled={busy}
          />
        )}
        <label className="flex flex-col gap-1 text-muted-foreground text-xs">
          Speed ({speedSupported ? speed.toFixed(1) : "1.0"}×)
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.1}
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            disabled={busy || !speedSupported}
            className="w-40 disabled:opacity-50"
            title={speedSupported ? undefined : "This voice doesn't support speed control"}
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Button
          onClick={speak}
          disabled={busy || !isDesktop() || voices.length === 0}
          size="sm"
        >
          {busy ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <Volume2 className="mr-1 h-4 w-4" />
          )}
          {compare ? "Synthesize both" : "Speak"}
        </Button>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={compare}
            onCheckedChange={(checked) => setCompare(checked === true)}
            disabled={busy || voices.length < 2}
          />
          A/B compare two voices
        </label>
      </div>

      {error && (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-destructive text-sm">
          {error}
        </p>
      )}
      {savedNote && (
        <p className="rounded-md border border-border bg-muted/40 p-3 text-muted-foreground text-sm">
          {savedNote}
        </p>
      )}

      {outputs.length > 0 && (
        <div className={outputs.length > 1 ? "grid gap-4 sm:grid-cols-2" : "grid gap-4"}>
          {outputs.map((output) => (
            <OutputCard key={output.voiceKey} output={output} onSave={save} />
          ))}
        </div>
      )}

      <RecentRuns
        tool={TOOL}
        selectedId={selectedRunId}
        onSelect={restoreRun}
        summarize={(saved) => {
          const params = saved.params as { voiceA?: string; voiceB?: string };
          const voicesStr = [params.voiceA, params.voiceB]
            .filter(Boolean)
            .join(" vs ");
          return `${voicesStr || "—"} · "${saved.input.text?.slice(0, 40) ?? ""}"`;
        }}
      />
    </div>
  );
}

function OutputCard({
  output,
  onSave,
}: {
  output: SynthOutput;
  onSave: (output: SynthOutput) => void;
}) {
  const waveformRef = useRef<WaveformHandle>(null);
  return (
    <div className="space-y-2 rounded-md border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium text-sm">{output.label}</span>
        <span className="shrink-0 text-muted-foreground text-xs">
          {output.cached ? "cache hit" : `${output.synthMs} ms`}
        </span>
      </div>
      <Waveform ref={waveformRef} path={output.path} />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => waveformRef.current?.playRange(0)}
        >
          <Play className="mr-1 h-3.5 w-3.5" /> Play
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onSave(output)}>
          <Download className="mr-1 h-3.5 w-3.5" /> Save to library
        </Button>
      </div>
    </div>
  );
}

function VoiceSelect({
  label,
  groups,
  value,
  onChange,
  disabled,
}: {
  label: string;
  groups: PickerGroup[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 text-muted-foreground text-xs">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="h-9 rounded-md border border-input bg-transparent px-2 text-foreground text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {groups.map((group) => (
          <optgroup key={group.id} label={group.label}>
            {group.voices.map((voice) => (
              <option key={voice.key} value={voice.key}>
                {voice.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
