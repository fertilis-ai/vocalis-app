import { Download, Flame, Loader2, MicVocal, Play, Trash2, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type BenchInput, InputSourcePanel } from "@/components/bench/input-source-panel";
import { ParamPanel } from "@/components/bench/param-panel";
import { RecentRuns } from "@/components/bench/recent-runs";
import { Waveform, type WaveformHandle } from "@/components/bench/waveform";
import { Button } from "@/components/ui/button";
import { defaultParams, findEngine } from "@/lib/engines/descriptors";
import {
  cloneTtsSynthesize,
  cloneTtsUnload,
  cloneTtsWarm,
  ttsSaveToLibrary,
} from "@/lib/engines/local";
import type { PlaygroundRun } from "@/lib/schemas/playground";
import { isDesktop } from "@/lib/storage";
import { useModelsStore } from "@/stores/models-store";
import { personDir, usePeopleStore } from "@/stores/people-store";
import { usePlaygroundStore } from "@/stores/playground-store";

const TOOL = "clone";

/** Sentinel option: clone from an ad-hoc clip instead of a Person's ref. */
const CUSTOM_REF = "custom";

/** A completed clone synthesis, ready to render as a labelled waveform. */
interface CloneOutput {
  refLabel: string;
  path: string;
  cached: boolean;
  engineLoadMs: number;
  synthMs: number;
}

export function CloneTool() {
  const engine = findEngine("cloneTts", "local.zipvoice");
  const installed = useModelsStore((s) => s.installed);
  const installedScanned = useModelsStore((s) => s.installedScanned);
  const loadInstalled = useModelsStore((s) => s.loadInstalled);
  const people = usePeopleStore((s) => s.people);
  const loadPeople = usePeopleStore((s) => s.loadAll);
  useEffect(() => {
    if (!installedScanned) void loadInstalled();
    void loadPeople();
  }, [installedScanned, loadInstalled, loadPeople]);

  const modelInstalled = installed.some((m) => m.task === "clone-tts");

  // People with a saved ZipVoice clone ref — the ready-made references.
  const clonedPeople = useMemo(
    () => Object.values(people).filter((p) => p.clones.zipvoice),
    [people],
  );

  const [refChoice, setRefChoice] = useState<string>(CUSTOM_REF);
  const [customClip, setCustomClip] = useState<BenchInput | null>(null);
  const [customRefText, setCustomRefText] = useState("");
  const [text, setText] = useState(
    "Voice cloning runs fully on this machine — this sentence is spoken in the reference clip's voice.",
  );
  const [params, setParams] = useState<Record<string, unknown>>(() =>
    engine ? defaultParams(engine) : {},
  );
  const setParam = useCallback(
    (key: string, value: unknown) => setParams((p) => ({ ...p, [key]: value })),
    [],
  );

  // Prefer a Person's ref once profiles load, if the user hasn't picked yet.
  const touchedRef = useRef(false);
  useEffect(() => {
    if (!touchedRef.current && clonedPeople.length > 0) {
      setRefChoice(clonedPeople[0].id);
    }
  }, [clonedPeople]);

  /** The reference that will condition synthesis, or null if incomplete. */
  const reference = useMemo(() => {
    if (refChoice !== CUSTOM_REF) {
      const person = clonedPeople.find((p) => p.id === refChoice);
      const clone = person?.clones.zipvoice;
      if (!person || !clone) return null;
      return {
        label: `${person.name} — clone ref`,
        refAudio: `${personDir(person.id)}/${clone.refAudio}`,
        refText: clone.refText,
      };
    }
    if (!customClip || !customRefText.trim()) return null;
    return {
      label: customClip.name,
      refAudio: customClip.path,
      refText: customRefText.trim(),
    };
  }, [refChoice, clonedPeople, customClip, customRefText]);

  const [output, setOutput] = useState<CloneOutput | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [engineBusy, setEngineBusy] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const addRun = usePlaygroundStore((s) => s.addRun);

  const synthesize = useCallback(async () => {
    if (!reference || !text.trim() || busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    setSelectedRunId(null);
    const startedAt = performance.now();
    try {
      const res = await cloneTtsSynthesize(text, reference.refAudio, reference.refText, {
        speed: typeof params.speed === "number" ? params.speed : undefined,
        numSteps: typeof params.numSteps === "number" ? params.numSteps : undefined,
      });
      const result: CloneOutput = {
        refLabel: reference.label,
        path: res.path,
        cached: res.cached,
        engineLoadMs: res.engineLoadMs,
        synthMs: res.synthMs,
      };
      setOutput(result);
      await addRun({
        tool: TOOL,
        engineId: engine?.id ?? null,
        durationMs: Math.round(performance.now() - startedAt),
        input: { kind: "text", text, name: text.slice(0, 60) },
        params: { ...params, reference: reference.label, refText: reference.refText },
        result,
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [reference, text, busy, params, engine, addRun]);

  const warm = useCallback(async () => {
    setEngineBusy(true);
    setError(null);
    try {
      const ms = await cloneTtsWarm();
      setNote(ms > 0 ? `Engine loaded in ${Math.round(ms)} ms.` : "Engine already warm.");
    } catch (err) {
      setError(String(err));
    } finally {
      setEngineBusy(false);
    }
  }, []);

  const unload = useCallback(async () => {
    setEngineBusy(true);
    setError(null);
    try {
      const wasLoaded = await cloneTtsUnload();
      setNote(wasLoaded ? "Engine unloaded." : "Engine was not loaded.");
    } catch (err) {
      setError(String(err));
    } finally {
      setEngineBusy(false);
    }
  }, []);

  const save = useCallback(async (out: CloneOutput) => {
    try {
      const path = await ttsSaveToLibrary(out.path, `clone ${out.refLabel}`);
      setNote(`Saved to library: ${path.split("/").pop()}`);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const restoreRun = useCallback((saved: PlaygroundRun) => {
    setText(saved.input.text ?? "");
    const { reference: _ref, refText: _refText, ...knobs } = saved.params as Record<string, unknown>;
    setParams(knobs);
    setOutput((saved.result as CloneOutput | null) ?? null);
    setError(null);
    setNote(null);
    setSelectedRunId(saved.id);
  }, []);

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-y-auto p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-semibold text-xl">Voice cloning</h1>
          <p className="text-muted-foreground text-sm">
            Zero-shot ZipVoice synthesis conditioned on a reference clip + its exact
            transcript. English & Chinese only — no French (spec §7.1).
          </p>
        </div>
        <span className="flex items-center gap-1 rounded-full border border-border px-2 py-1 text-muted-foreground text-xs">
          <Zap className="h-3 w-3" />
          {engine?.label ?? "ZipVoice (local)"}
        </span>
      </header>

      {!isDesktop() && (
        <p className="text-muted-foreground text-sm">
          Voice cloning requires the desktop app.
        </p>
      )}
      {installedScanned && !modelInstalled && (
        <p className="rounded-md border border-border bg-muted/40 p-3 text-muted-foreground text-sm">
          No clone-TTS model installed — download ZipVoice in Models first.
        </p>
      )}

      <section className="space-y-2">
        <h2 className="font-medium text-sm">Reference voice</h2>
        <select
          value={refChoice}
          onChange={(e) => {
            touchedRef.current = true;
            setRefChoice(e.target.value);
          }}
          disabled={busy}
          className="h-9 w-full max-w-sm rounded-md border border-input bg-transparent px-2 text-foreground text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {clonedPeople.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name} — saved clone reference
            </option>
          ))}
          <option value={CUSTOM_REF}>Custom clip…</option>
        </select>

        {refChoice === CUSTOM_REF ? (
          <div className="space-y-2">
            <InputSourcePanel value={customClip} onChange={setCustomClip} disabled={busy} />
            <textarea
              value={customRefText}
              onChange={(e) => setCustomRefText(e.target.value)}
              rows={2}
              className="w-full resize-y rounded-md border border-input bg-transparent p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="Exact transcript of the reference clip (required — cloning conditions on it)…"
            />
            <p className="text-muted-foreground text-xs">
              Only clone voices you own or have consent to clone (spec §2.4). A clean
              10–60 s clip with a word-exact transcript gives the best match.
            </p>
          </div>
        ) : (
          reference && (
            <p className="rounded-md border border-border bg-muted/40 p-3 text-muted-foreground text-xs">
              Reference transcript: “{reference.refText}”
            </p>
          )
        )}
      </section>

      <ParamPanel specs={engine?.params ?? []} values={params} onChange={setParam} />

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        className="w-full resize-y rounded-md border border-input bg-transparent p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        placeholder="Type something to speak in the cloned voice…"
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={synthesize}
          disabled={busy || !isDesktop() || !modelInstalled || !reference || !text.trim()}
        >
          {busy ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <MicVocal className="mr-1 h-4 w-4" />
          )}
          Synthesize
        </Button>
        {/* Engine lifecycle knobs: ZipVoice is ~600 MB resident and never
            auto-loaded, so the bench exposes warm-up (TTFA profiling) and
            eviction directly. */}
        <Button
          size="sm"
          variant="outline"
          onClick={warm}
          disabled={engineBusy || busy || !isDesktop() || !modelInstalled}
        >
          <Flame className="mr-1 h-3.5 w-3.5" /> Warm engine
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={unload}
          disabled={engineBusy || busy || !isDesktop()}
        >
          <Trash2 className="mr-1 h-3.5 w-3.5" /> Unload
        </Button>
      </div>

      {error && (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-destructive text-sm">
          {error}
        </p>
      )}
      {note && (
        <p className="rounded-md border border-border bg-muted/40 p-3 text-muted-foreground text-sm">
          {note}
        </p>
      )}

      {output && <OutputCard output={output} onSave={save} />}

      <RecentRuns
        tool={TOOL}
        selectedId={selectedRunId}
        onSelect={restoreRun}
        summarize={(saved) => {
          const p = saved.params as { reference?: string };
          return `${p.reference ?? "—"} · "${saved.input.text?.slice(0, 40) ?? ""}"`;
        }}
      />
    </div>
  );
}

function OutputCard({
  output,
  onSave,
}: {
  output: CloneOutput;
  onSave: (output: CloneOutput) => void;
}) {
  const waveformRef = useRef<WaveformHandle>(null);
  const timing = output.cached
    ? "cache hit"
    : output.engineLoadMs > 0
      ? `load ${Math.round(output.engineLoadMs)} ms + synth ${Math.round(output.synthMs)} ms`
      : `synth ${Math.round(output.synthMs)} ms (warm)`;
  return (
    <div className="space-y-2 rounded-md border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium text-sm">{output.refLabel}</span>
        <span className="shrink-0 text-muted-foreground text-xs">{timing}</span>
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
