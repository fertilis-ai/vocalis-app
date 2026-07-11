import { Fingerprint, Loader2, Play } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { type BenchInput, InputSourcePanel } from "@/components/bench/input-source-panel";
import { ParamPanel } from "@/components/bench/param-panel";
import { RecentRuns } from "@/components/bench/recent-runs";
import { Waveform, type WaveformHandle } from "@/components/bench/waveform";
import { EngineChip } from "@/components/shared/engine-chip";
import { Button } from "@/components/ui/button";
import { defaultParams } from "@/lib/engines/descriptors";
import type { DiarizeFileResult } from "@/lib/engines/local";
import { diarizeWithEngine } from "@/lib/engines/port";
import { useEngineResolution } from "@/lib/routing/use-engine";
import type { PlaygroundRun } from "@/lib/schemas/playground";
import { speakerColor, speakerName, speakerOrder } from "@/lib/speaker-labels";
import { isDesktop } from "@/lib/storage";
import { usePlaygroundStore } from "@/stores/playground-store";
import { useSettingsStore } from "@/stores/settings-store";

const TOOL = "diarization";

export function DiarizationTool() {
  const [engineOverride, setEngineOverride] = useState<string | null>(null);
  const engine = useEngineResolution("diarization", engineOverride).active;
  const [params, setParams] = useState<Record<string, unknown>>(() =>
    engine ? defaultParams(engine) : {},
  );
  const [input, setInput] = useState<BenchInput | null>(null);
  const [result, setResult] = useState<DiarizeFileResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const addRun = usePlaygroundStore((s) => s.addRun);
  const apiKeys = useSettingsStore((s) => s.apiKeys);

  const setParam = useCallback(
    (key: string, value: unknown) => setParams((p) => ({ ...p, [key]: value })),
    [],
  );

  const analyze = useCallback(async () => {
    if (!input || busy) return;
    setBusy(true);
    setError(null);
    setSelectedRunId(null);
    const startedAt = performance.now();
    try {
      const numSpeakers =
        typeof params.numSpeakers === "number" && params.numSpeakers >= 1
          ? Math.round(params.numSpeakers)
          : undefined;
      if (!engine) throw new Error("no diarization engine selected");
      const diarized = await diarizeWithEngine(engine, input.path, {
        apiKeys,
        numSpeakers,
        threshold: typeof params.threshold === "number" ? params.threshold : undefined,
      });
      setResult(diarized);
      await addRun({
        tool: TOOL,
        engineId: engine?.id ?? null,
        durationMs: Math.round(performance.now() - startedAt),
        input,
        params,
        result: diarized,
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [input, busy, params, engine, addRun, apiKeys]);

  const restoreRun = useCallback((saved: PlaygroundRun) => {
    if (saved.input.path) {
      setInput({
        kind: "file",
        path: saved.input.path,
        name: saved.input.name ?? saved.input.path,
      });
    }
    setParams(saved.params);
    setResult(saved.result as DiarizeFileResult);
    setError(null);
    setSelectedRunId(saved.id);
  }, []);

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-y-auto p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-semibold text-xl">Speaker diarization</h1>
          <p className="text-muted-foreground text-sm">
            Who spoke when — segments a clip and clusters it by voice.
          </p>
        </div>
        <EngineChip
          task="diarization"
          override={engineOverride}
          onOverride={setEngineOverride}
        />
      </header>

      <ParamPanel specs={engine?.params ?? []} values={params} onChange={setParam} />

      {!isDesktop() && (
        <p className="text-muted-foreground text-sm">
          Speaker diarization requires the desktop app.
        </p>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-sm">Analyze a clip</h2>
          <Button
            size="sm"
            onClick={analyze}
            disabled={!engine || busy || !input || !isDesktop()}
          >
            {busy ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Fingerprint className="mr-1 h-4 w-4" />
            )}
            Diarize
          </Button>
        </div>
        <InputSourcePanel value={input} onChange={setInput} disabled={busy} />
      </section>

      {error && (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-destructive text-sm">
          {error}
        </p>
      )}

      {input && result && <DiarizationResult path={input.path} result={result} />}

      <RecentRuns
        tool={TOOL}
        selectedId={selectedRunId}
        onSelect={restoreRun}
        summarize={(saved) => {
          const diarized = saved.result as DiarizeFileResult | null;
          return diarized
            ? `${diarized.numSpeakers} speakers / ${diarized.segments.length} segments`
            : "—";
        }}
      />
    </div>
  );
}

function DiarizationResult({
  path,
  result,
}: {
  path: string;
  result: DiarizeFileResult;
}) {
  const waveformRef = useRef<WaveformHandle | null>(null);
  const order = speakerOrder(result.segments);
  const colorOf = (label: number) => speakerColor(order.indexOf(label));
  const nameOf = (label: number) => speakerName(order.indexOf(label));
  const talkTime = (label: number) =>
    result.segments
      .filter((s) => s.speaker === label)
      .reduce((sum, s) => sum + (s.end - s.start), 0);

  return (
    <div className="space-y-3 rounded-md border border-border bg-card p-4">
      <Waveform ref={waveformRef} path={path} segments={result.segments} />

      {/* Speaker-colored timeline strip under the waveform. */}
      <div
        className="relative h-3 w-full overflow-hidden rounded bg-muted"
        aria-label="Speaker timeline"
      >
        {result.segments.map((segment) => (
          <div
            key={`${segment.start}-${segment.end}`}
            className="absolute h-full"
            style={{
              left: `${(segment.start / Math.max(result.durationSecs, 0.001)) * 100}%`,
              width: `${((segment.end - segment.start) / Math.max(result.durationSecs, 0.001)) * 100}%`,
              backgroundColor: colorOf(segment.speaker),
            }}
          />
        ))}
      </div>

      <div className="flex flex-wrap gap-3">
        {order.map((label) => (
          <span key={label} className="flex items-center gap-1.5 text-xs">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: colorOf(label) }}
            />
            {nameOf(label)}
            <span className="text-muted-foreground tabular-nums">
              {talkTime(label).toFixed(1)} s
            </span>
          </span>
        ))}
      </div>

      <p className="text-muted-foreground text-xs">
        {result.numSpeakers} speaker{result.numSpeakers === 1 ? "" : "s"},{" "}
        {result.segments.length} segment{result.segments.length === 1 ? "" : "s"} in{" "}
        {result.durationSecs.toFixed(1)} s · {result.processingMs.toFixed(0)} ms
      </p>

      {result.segments.length > 0 && (
        <ul className="max-h-56 space-y-0.5 overflow-y-auto">
          {result.segments.map((segment, i) => (
            <li
              key={`${segment.start}-${segment.end}-${segment.speaker}`}
              className="flex items-center gap-2 text-xs"
            >
              <button
                type="button"
                onClick={() => waveformRef.current?.playRange(segment.start, segment.end)}
                aria-label={`Play segment ${i + 1}`}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Play className="h-3.5 w-3.5" />
              </button>
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: colorOf(segment.speaker) }}
              />
              <span className="w-20">{nameOf(segment.speaker)}</span>
              <span className="tabular-nums">
                {segment.start.toFixed(2)} s → {segment.end.toFixed(2)} s
              </span>
              <span className="text-muted-foreground tabular-nums">
                ({(segment.end - segment.start).toFixed(2)} s)
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
