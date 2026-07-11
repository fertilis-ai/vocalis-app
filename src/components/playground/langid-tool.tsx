import { Globe, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { type BenchInput, InputSourcePanel } from "@/components/bench/input-source-panel";
import { RecentRuns } from "@/components/bench/recent-runs";
import { EngineChip } from "@/components/shared/engine-chip";
import { Button } from "@/components/ui/button";
import { type LangIdResult, langidFile } from "@/lib/engines/local";
import { useEngineResolution } from "@/lib/routing/use-engine";
import type { PlaygroundRun } from "@/lib/schemas/playground";
import { isDesktop } from "@/lib/storage";
import { usePlaygroundStore } from "@/stores/playground-store";

const TOOL = "lang-id";

/** ISO 639-1 (plus a few whisper codes) → friendly names for the detections
 *  whisper actually emits. Unknown codes fall back to the raw code. */
const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  fr: "French",
  de: "German",
  es: "Spanish",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  ru: "Russian",
  pl: "Polish",
  uk: "Ukrainian",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  ar: "Arabic",
  hi: "Hindi",
  tr: "Turkish",
  sv: "Swedish",
  da: "Danish",
  no: "Norwegian",
  fi: "Finnish",
  cs: "Czech",
  el: "Greek",
  he: "Hebrew",
  th: "Thai",
  vi: "Vietnamese",
  id: "Indonesian",
  ro: "Romanian",
  hu: "Hungarian",
  ca: "Catalan",
};

function languageName(code: string): string {
  return LANGUAGE_NAMES[code.toLowerCase()] ?? code.toUpperCase();
}

export function LangIdTool() {
  const [engineOverride, setEngineOverride] = useState<string | null>(null);
  const engine = useEngineResolution("langId", engineOverride).active;

  const [input, setInput] = useState<BenchInput | null>(null);
  const [result, setResult] = useState<LangIdResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const addRun = usePlaygroundStore((s) => s.addRun);

  const identify = useCallback(async () => {
    if (!input || busy) return;
    setBusy(true);
    setError(null);
    setSelectedRunId(null);
    const startedAt = performance.now();
    try {
      const res = await langidFile(input.path);
      setResult(res);
      await addRun({
        tool: TOOL,
        engineId: engine?.id ?? null,
        durationMs: Math.round(performance.now() - startedAt),
        input,
        params: {},
        result: res,
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [input, busy, engine, addRun]);

  const restoreRun = useCallback((saved: PlaygroundRun) => {
    if (saved.input.path) {
      setInput({
        kind: (saved.input.kind === "text" ? "file" : saved.input.kind) as BenchInput["kind"],
        path: saved.input.path,
        name: saved.input.name ?? saved.input.path,
      });
    }
    setResult(saved.result as LangIdResult);
    setError(null);
    setSelectedRunId(saved.id);
  }, []);

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-y-auto p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-semibold text-xl">Spoken language ID</h1>
          <p className="text-muted-foreground text-sm">
            Detect the dominant language spoken in a clip (Whisper, 99 languages).
          </p>
        </div>
        <EngineChip task="langId" override={engineOverride} onOverride={setEngineOverride} />
      </header>

      <p className="rounded-md border border-border bg-muted/40 p-3 text-muted-foreground text-xs">
        The Whisper language-ID API returns a single top language — no per-language
        confidence distribution is exposed, so this tool shows one detection rather
        than a top-5 table.
      </p>

      {!isDesktop() && (
        <p className="text-muted-foreground text-sm">
          Spoken language ID requires the desktop app.
        </p>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-sm">Analyze a clip</h2>
          <Button
            size="sm"
            onClick={identify}
            disabled={!engine || busy || !input || !isDesktop()}
          >
            {busy ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Globe className="mr-1 h-4 w-4" />
            )}
            Identify
          </Button>
        </div>

        <InputSourcePanel value={input} onChange={setInput} disabled={busy} />

        {error && (
          <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-destructive text-sm">
            {error}
          </p>
        )}

        {result && (
          <div className="flex items-center gap-4 rounded-md border border-border bg-card p-6">
            <Globe className="h-8 w-8 text-primary" />
            <div className="flex-1">
              <p className="font-semibold text-2xl">{languageName(result.lang)}</p>
              <p className="text-muted-foreground text-xs">
                code <span className="font-mono">{result.lang || "—"}</span> ·{" "}
                {result.processingMs.toFixed(0)} ms
              </p>
            </div>
          </div>
        )}

        <RecentRuns
          tool={TOOL}
          selectedId={selectedRunId}
          onSelect={restoreRun}
          summarize={(saved) => {
            const res = saved.result as LangIdResult | null;
            return res ? `${languageName(res.lang)} (${res.lang})` : "—";
          }}
        />
      </section>
    </div>
  );
}
