import { Loader2, Play, ScanSearch, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type BenchInput,
  InputSourcePanel,
} from "@/components/bench/input-source-panel";
import { LevelMeter } from "@/components/bench/level-meter";
import { ParamPanel } from "@/components/bench/param-panel";
import { RecentRuns } from "@/components/bench/recent-runs";
import { Waveform, type WaveformHandle } from "@/components/bench/waveform";
import { EngineChip } from "@/components/shared/engine-chip";
import { Button } from "@/components/ui/button";
import { defaultParams } from "@/lib/engines/descriptors";
import {
  type KeywordHit,
  type KwsAnalysis,
  kwsAnalyzeFile,
  kwsDefaultKeywords,
  type PipelineEvent,
  startKwsPipeline,
  stopAsrPipeline,
} from "@/lib/engines/local";
import { useEngineResolution } from "@/lib/routing/use-engine";
import {
  KWS_LISTS_PATH,
  type KwsList,
  kwsListsFileSchema,
} from "@/lib/schemas/kws-lists";
import type { PlaygroundRun } from "@/lib/schemas/playground";
import { isDesktop, readFile, writeFile } from "@/lib/storage";
import { usePlaygroundStore } from "@/stores/playground-store";

const TOOL = "kws";

function scoreParam(params: Record<string, unknown>): number | undefined {
  return typeof params.keywordsScore === "number" ? params.keywordsScore : undefined;
}

export function KwsTool() {
  const [engineOverride, setEngineOverride] = useState<string | null>(null);
  const engine = useEngineResolution("kws", engineOverride).active;
  const [params, setParams] = useState<Record<string, unknown>>(() =>
    engine ? defaultParams(engine) : {},
  );
  const setParam = useCallback(
    (key: string, value: unknown) => setParams((p) => ({ ...p, [key]: value })),
    [],
  );

  const [keywords, setKeywords] = useState("");
  const keywordsScore = scoreParam(params);

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-y-auto p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-semibold text-xl">Keyword spotting</h1>
          <p className="text-muted-foreground text-sm">
            Detect wake-words in the live mic or a clip (streaming Zipformer KWS).
          </p>
        </div>
        <EngineChip task="kws" override={engineOverride} onOverride={setEngineOverride} />
      </header>

      <ParamPanel specs={engine?.params ?? []} values={params} onChange={setParam} />

      {!isDesktop() && (
        <p className="text-muted-foreground text-sm">
          Keyword spotting requires the desktop app.
        </p>
      )}

      <KeywordEditor keywords={keywords} onChange={setKeywords} />

      <LiveDetection keywords={keywords} keywordsScore={keywordsScore} disabled={!engine} />
      <FileDetection
        keywords={keywords}
        keywordsScore={keywordsScore}
        params={params}
        setParams={setParams}
        onRestoreKeywords={setKeywords}
        engineId={engine?.id ?? null}
        disabled={!engine}
      />
    </div>
  );
}

// ── Keyword editor with bundled defaults + saved lists ───────────────────────

async function loadLists(): Promise<KwsList[]> {
  if (!isDesktop()) return [];
  try {
    const parsed = kwsListsFileSchema.parse(JSON.parse(await readFile(KWS_LISTS_PATH)));
    return parsed.lists;
  } catch {
    return [];
  }
}

async function persistLists(lists: KwsList[]): Promise<void> {
  await writeFile(KWS_LISTS_PATH, JSON.stringify({ lists }, null, 2));
}

function KeywordEditor({
  keywords,
  onChange,
}: {
  keywords: string;
  onChange: (value: string) => void;
}) {
  const [phrases, setPhrases] = useState("");
  const [lists, setLists] = useState<KwsList[]>([]);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    void loadLists().then(setLists);
  }, []);

  const loadDefaults = useCallback(async () => {
    const defaults = await kwsDefaultKeywords();
    onChange(defaults.tokens.trim());
    setPhrases(defaults.phrases.trim());
  }, [onChange]);

  const saveList = useCallback(async () => {
    const name = newName.trim();
    if (!name || !keywords.trim()) return;
    const next = [...lists.filter((l) => l.name !== name), { name, keywords }];
    setLists(next);
    setNewName("");
    await persistLists(next);
  }, [newName, keywords, lists]);

  const deleteList = useCallback(
    async (name: string) => {
      const next = lists.filter((l) => l.name !== name);
      setLists(next);
      await persistLists(next);
    },
    [lists],
  );

  return (
    <section className="space-y-2 rounded-md border border-border p-4">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 font-medium text-sm">Keywords</h2>
        <Button size="sm" variant="outline" onClick={loadDefaults} disabled={!isDesktop()}>
          Load model defaults
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        One keyword per line, as sherpa BPE tokens (e.g.{" "}
        <span className="font-mono">▁HE LL O ▁WORLD</span>). Runtime plain-text
        tokenization isn't exposed by sherpa-onnx — use “Load model defaults” or
        convert with <span className="font-mono">sherpa-onnx-cli text2token</span>.
        Add <span className="font-mono">:2.0</span> after a line to boost it.
      </p>
      <textarea
        value={keywords}
        onChange={(e) => onChange(e.target.value)}
        rows={5}
        spellCheck={false}
        placeholder="▁HE Y ▁S I RI&#10;▁A LE X A"
        className="w-full resize-y rounded-md border border-border bg-background p-2 font-mono text-xs"
      />
      {phrases && (
        <details className="text-muted-foreground text-xs">
          <summary className="cursor-pointer">Reference phrases (bundled)</summary>
          <pre className="mt-1 whitespace-pre-wrap">{phrases}</pre>
        </details>
      )}

      {lists.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {lists.map((list) => (
            <span
              key={list.name}
              className="flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-xs"
            >
              <button
                type="button"
                onClick={() => onChange(list.keywords)}
                className="hover:text-primary"
              >
                {list.name}
              </button>
              <button
                type="button"
                onClick={() => deleteList(list.name)}
                aria-label={`Delete list ${list.name}`}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Save current as…"
          className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={saveList}
          disabled={!newName.trim() || !keywords.trim() || !isDesktop()}
        >
          Save list
        </Button>
      </div>
    </section>
  );
}

// ── Live detection ───────────────────────────────────────────────────────────

interface LiveHit extends KeywordHit {
  /** Wall-clock arrival for a stable list key. */
  at: number;
}

function LiveDetection({
  keywords,
  keywordsScore,
  disabled,
}: {
  keywords: string;
  keywordsScore?: number;
  disabled: boolean;
}) {
  const [listening, setListening] = useState(false);
  const [level, setLevel] = useState({ rms: 0, peak: 0 });
  const [hits, setHits] = useState<LiveHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const pipelineId = useRef<number | null>(null);

  const handleEvent = useCallback((event: PipelineEvent) => {
    switch (event.type) {
      case "ready":
        setHits([]);
        setListening(true);
        break;
      case "level":
        setLevel({ rms: event.rms, peak: event.peak });
        break;
      case "keywordHit":
        setHits((prev) => [
          { keyword: event.keyword, startTime: event.startTime, at: performance.now() },
          ...prev,
        ]);
        break;
      case "error":
        setError(event.message);
        setListening(false);
        pipelineId.current = null;
        break;
      case "stopped":
        setListening(false);
        pipelineId.current = null;
        break;
    }
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      pipelineId.current = await startKwsPipeline({
        keywords,
        keywordsScore,
        onEvent: handleEvent,
      });
    } catch (err) {
      setError(String(err));
    }
  }, [keywords, keywordsScore, handleEvent]);

  const stop = useCallback(() => {
    if (pipelineId.current !== null) void stopAsrPipeline(pipelineId.current);
  }, []);

  useEffect(() => {
    return () => {
      if (pipelineId.current !== null) void stopAsrPipeline(pipelineId.current);
    };
  }, []);

  return (
    <section className="space-y-3 rounded-md border border-border p-4">
      <div className="flex items-center gap-3">
        <h2 className="flex-1 font-medium text-sm">Live monitor</h2>
        {listening ? (
          <Button size="sm" variant="destructive" onClick={stop}>
            <Square className="mr-1 h-4 w-4" /> Stop
          </Button>
        ) : (
          <Button size="sm" onClick={start} disabled={disabled || !isDesktop()}>
            <ScanSearch className="mr-1 h-4 w-4" /> Listen
          </Button>
        )}
      </div>
      {listening && <LevelMeter rms={level.rms} peak={level.peak} />}
      {hits.length > 0 && (
        <ul className="max-h-48 space-y-0.5 overflow-y-auto">
          {hits.map((hit) => (
            <li key={hit.at} className="flex items-center gap-2 text-xs">
              <ScanSearch className="h-3.5 w-3.5 text-primary" />
              <span className="font-medium">{hit.keyword}</span>
              <span className="text-muted-foreground tabular-nums">
                @ {hit.startTime.toFixed(2)} s
              </span>
            </li>
          ))}
        </ul>
      )}
      {listening && hits.length === 0 && (
        <p className="text-muted-foreground text-xs">Listening — say a keyword…</p>
      )}
      {error && <p className="text-destructive text-xs">{error}</p>}
    </section>
  );
}

// ── File detection ───────────────────────────────────────────────────────────

function FileDetection({
  keywords,
  keywordsScore,
  params,
  setParams,
  onRestoreKeywords,
  engineId,
  disabled,
}: {
  keywords: string;
  keywordsScore?: number;
  params: Record<string, unknown>;
  setParams: (params: Record<string, unknown>) => void;
  onRestoreKeywords: (keywords: string) => void;
  engineId: string | null;
  disabled: boolean;
}) {
  const [input, setInput] = useState<BenchInput | null>(null);
  const [analysis, setAnalysis] = useState<KwsAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const waveformRef = useRef<WaveformHandle | null>(null);
  const addRun = usePlaygroundStore((s) => s.addRun);

  const analyze = useCallback(async () => {
    if (!input || busy) return;
    setBusy(true);
    setError(null);
    setSelectedRunId(null);
    const startedAt = performance.now();
    try {
      const result = await kwsAnalyzeFile(input.path, { keywords, keywordsScore });
      setAnalysis(result);
      await addRun({
        tool: TOOL,
        engineId,
        durationMs: Math.round(performance.now() - startedAt),
        input,
        params: { ...params, keywords },
        result,
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [input, busy, keywords, keywordsScore, params, engineId, addRun]);

  const restoreRun = useCallback(
    (saved: PlaygroundRun) => {
      if (saved.input.path) {
        setInput({
          kind: (saved.input.kind === "text" ? "file" : saved.input.kind) as BenchInput["kind"],
          path: saved.input.path,
          name: saved.input.name ?? saved.input.path,
        });
      }
      // `keywords` rides along in the params bag (playgroundRunSchema has no
      // dedicated field for it) — pull it out to restore the editor's own
      // state instead of leaving it stale while the ParamPanel values change.
      const { keywords: savedKeywords, ...restParams } = saved.params;
      if (typeof savedKeywords === "string") onRestoreKeywords(savedKeywords);
      setParams(restParams);
      setAnalysis(saved.result as KwsAnalysis);
      setError(null);
      setSelectedRunId(saved.id);
    },
    [setParams, onRestoreKeywords],
  );

  // Point markers rendered as short highlighted spans on the waveform.
  const markers = analysis?.hits.map((hit) => ({
    start: hit.startTime,
    end: hit.startTime + 0.3,
  }));

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-medium text-sm">Analyze a clip</h2>
        <Button
          size="sm"
          onClick={analyze}
          disabled={disabled || busy || !input || !isDesktop()}
        >
          {busy ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <ScanSearch className="mr-1 h-4 w-4" />
          )}
          Analyze
        </Button>
      </div>

      <InputSourcePanel value={input} onChange={setInput} disabled={busy} />

      {error && (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-destructive text-sm">
          {error}
        </p>
      )}

      {input && analysis && (
        <div className="space-y-3 rounded-md border border-border bg-card p-4">
          <Waveform ref={waveformRef} path={input.path} segments={markers} />
          <p className="text-muted-foreground text-xs">
            {analysis.hits.length} detection
            {analysis.hits.length === 1 ? "" : "s"} in{" "}
            {analysis.durationSecs.toFixed(1)} s
          </p>
          {analysis.hits.length > 0 && (
            <ul className="max-h-48 space-y-0.5 overflow-y-auto">
              {analysis.hits.map((hit) => (
                <li
                  key={`${hit.keyword}-${hit.startTime}`}
                  className="flex items-center gap-2 text-xs"
                >
                  <button
                    type="button"
                    onClick={() =>
                      waveformRef.current?.playRange(hit.startTime, hit.startTime + 1.5)
                    }
                    aria-label={`Play ${hit.keyword}`}
                    className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <Play className="h-3.5 w-3.5" />
                  </button>
                  <span className="font-medium">{hit.keyword}</span>
                  <span className="text-muted-foreground tabular-nums">
                    @ {hit.startTime.toFixed(2)} s
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <RecentRuns
        tool={TOOL}
        selectedId={selectedRunId}
        onSelect={restoreRun}
        summarize={(saved) => {
          const result = saved.result as KwsAnalysis | null;
          return result
            ? `${result.hits.length} hits / ${result.durationSecs.toFixed(1)} s`
            : "—";
        }}
      />
    </section>
  );
}
