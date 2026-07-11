import { FileAudio, Loader2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import {
  type BenchInput,
  InputSourcePanel,
} from "@/components/bench/input-source-panel";
import { ParamPanel } from "@/components/bench/param-panel";
import { RecentRuns } from "@/components/bench/recent-runs";
import { Waveform, type WaveformHandle } from "@/components/bench/waveform";
import { EngineChip } from "@/components/shared/engine-chip";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { defaultParams } from "@/lib/engines/descriptors";
import {
  asrTranscribeFileStreaming,
  type TranscribeFileResult,
  type WordSpan,
} from "@/lib/engines/local";
import { transcribeWithEngine } from "@/lib/engines/port";
import { useEngineResolution } from "@/lib/routing/use-engine";
import type { PlaygroundRun } from "@/lib/schemas/playground";
import { isDesktop } from "@/lib/storage";
import { usePlaygroundStore } from "@/stores/playground-store";
import { useSettingsStore } from "@/stores/settings-store";

const TOOL = "asr";

/** Both transcriptions of one run — `streaming` only in compare mode. */
interface FileRunResult {
  batch: TranscribeFileResult;
  streaming: TranscribeFileResult | null;
}

/**
 * Batch-file transcription on the shared bench (spec §2.3): wav in, offline
 * Whisper out, with RTF/latency stats — plus compare mode that runs the same
 * clip through the streaming Zipformer side by side.
 */
export function AsrFileSection() {
  const [engineOverride, setEngineOverride] = useState<string | null>(null);
  const engine = useEngineResolution("batchAsr", engineOverride).active;
  const streamingEngine = useEngineResolution("streamingAsr").active;
  const [params, setParams] = useState<Record<string, unknown>>(() =>
    engine ? defaultParams(engine) : {},
  );
  const [compare, setCompare] = useState(false);
  const [input, setInput] = useState<BenchInput | null>(null);
  const [result, setResult] = useState<FileRunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const waveformRef = useRef<WaveformHandle | null>(null);
  const addRun = usePlaygroundStore((s) => s.addRun);
  const apiKeys = useSettingsStore((s) => s.apiKeys);

  const setParam = useCallback(
    (key: string, value: unknown) => setParams((p) => ({ ...p, [key]: value })),
    [],
  );

  const transcribe = useCallback(async () => {
    if (!input || busy) return;
    setBusy(true);
    setError(null);
    setSelectedRunId(null);
    const startedAt = performance.now();
    try {
      const language =
        typeof params.language === "string" ? params.language : undefined;
      if (!engine) throw new Error("no batch engine selected");
      const batch = await transcribeWithEngine(engine, input.path, {
        apiKeys,
        language,
      });
      const streaming = compare
        ? await asrTranscribeFileStreaming(input.path)
        : null;
      const runResult: FileRunResult = { batch, streaming };
      setResult(runResult);
      await addRun({
        tool: TOOL,
        engineId: engine?.id ?? null,
        durationMs: Math.round(performance.now() - startedAt),
        input,
        params: { ...params, compare },
        result: runResult,
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [input, busy, params, compare, engine, addRun, apiKeys]);

  const restoreRun = useCallback((saved: PlaygroundRun) => {
    if (saved.input.path) {
      setInput({
        kind: (saved.input.kind === "text"
          ? "file"
          : saved.input.kind) as BenchInput["kind"],
        path: saved.input.path,
        name: saved.input.name ?? saved.input.path,
      });
    }
    const { compare: savedCompare, ...rest } = saved.params;
    setParams(rest);
    setCompare(savedCompare === true);
    setResult(saved.result as FileRunResult);
    setError(null);
    setSelectedRunId(saved.id);
  }, []);

  const playWord = useCallback((words: WordSpan[], index: number) => {
    const start = words[index].start;
    const end = index + 1 < words.length ? words[index + 1].start : undefined;
    waveformRef.current?.playRange(start, end);
  }, []);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-medium text-sm">Transcribe a clip</h2>
        <div className="flex items-center gap-3">
          <EngineChip
            task="batchAsr"
            override={engineOverride}
            onOverride={setEngineOverride}
          />
          <Button
            size="sm"
            onClick={transcribe}
            disabled={!engine || busy || !input || !isDesktop()}
          >
            {busy ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <FileAudio className="mr-1 h-4 w-4" />
            )}
            Transcribe
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
        <ParamPanel
          specs={engine?.params ?? []}
          values={params}
          onChange={setParam}
          disabled={busy}
        />
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={compare}
            onCheckedChange={(checked) => setCompare(checked === true)}
            disabled={busy || !streamingEngine}
          />
          Compare with {streamingEngine?.label ?? "streaming engine"}
        </label>
      </div>

      <InputSourcePanel value={input} onChange={setInput} disabled={busy} />

      {error && (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-destructive text-sm">
          {error}
        </p>
      )}

      {input && result && (
        <div className="space-y-3">
          <Waveform ref={waveformRef} path={input.path} />
          <div
            className={
              result.streaming ? "grid grid-cols-2 gap-3" : "space-y-3"
            }
          >
            <ResultCard
              label={engine?.label ?? "Batch"}
              result={result.batch}
              onPlayWord={playWord}
            />
            {result.streaming && (
              <ResultCard
                label={`${streamingEngine?.label ?? "Streaming"} (offline)`}
                result={result.streaming}
                onPlayWord={playWord}
              />
            )}
          </div>
        </div>
      )}

      <RecentRuns
        tool={TOOL}
        selectedId={selectedRunId}
        onSelect={restoreRun}
        summarize={(saved) => {
          const result = saved.result as FileRunResult | null;
          if (!result) return "—";
          const mode = result.streaming ? "compare · " : "";
          return `${mode}${result.batch.durationSecs.toFixed(1)} s · RTF ${result.batch.rtf.toFixed(2)}`;
        }}
      />
    </section>
  );
}

function ResultCard({
  label,
  result,
  onPlayWord,
}: {
  label: string;
  result: TranscribeFileResult;
  onPlayWord: (words: WordSpan[], index: number) => void;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border bg-card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-medium text-sm">{label}</h3>
        <span className="text-muted-foreground text-xs tabular-nums">
          {result.durationSecs.toFixed(1)} s audio ·{" "}
          {(result.processingMs / 1000).toFixed(2)} s · RTF{" "}
          {result.rtf.toFixed(2)}
        </span>
      </div>
      {result.words.length > 0 ? (
        <>
          <p className="text-sm leading-relaxed">
            {result.words.map((word, i) => (
              <span key={`${word.start}-${word.text}`}>
                <button
                  type="button"
                  title={`${word.start.toFixed(2)} s`}
                  onClick={() => onPlayWord(result.words, i)}
                  className="rounded-sm hover:bg-accent hover:text-accent-foreground"
                >
                  {word.text}
                </button>{" "}
              </span>
            ))}
          </p>
          <p className="text-muted-foreground text-xs">
            Click a word to play it — hover for its timestamp.
          </p>
        </>
      ) : (
        <p className="text-sm leading-relaxed">{result.text || "(no speech)"}</p>
      )}
    </div>
  );
}
