import { Loader2, Type } from "lucide-react";
import { useCallback, useState } from "react";
import { RecentRuns } from "@/components/bench/recent-runs";
import { EngineChip } from "@/components/shared/engine-chip";
import { Button } from "@/components/ui/button";
import { punctuateText } from "@/lib/engines/local";
import { useEngineResolution } from "@/lib/routing/use-engine";
import type { PlaygroundRun } from "@/lib/schemas/playground";
import { diffWords } from "@/lib/text-diff";
import { isDesktop } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { usePlaygroundStore } from "@/stores/playground-store";

const TOOL = "punctuation";

interface PunctuationResult {
  text: string;
}

function resultText(run: PlaygroundRun): string {
  return (run.result as PunctuationResult | null)?.text ?? "";
}

export function PunctuationTool() {
  const [text, setText] = useState(
    "hello there how are you today i think the meeting moved to 4pm",
  );
  const [output, setOutput] = useState<string | null>(null);
  const [ranText, setRanText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastInfo, setLastInfo] = useState<string | null>(null);
  const [engineOverride, setEngineOverride] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const engine = useEngineResolution("punctuation", engineOverride).active;
  const addRun = usePlaygroundStore((s) => s.addRun);

  const run = useCallback(async () => {
    const input = text.trim();
    if (!input || busy) return;
    setBusy(true);
    setError(null);
    setSelectedRunId(null);
    const startedAt = performance.now();
    try {
      const punctuated = await punctuateText(input);
      const durationMs = Math.round(performance.now() - startedAt);
      setOutput(punctuated);
      setRanText(input);
      setLastInfo(`restored in ${durationMs} ms`);
      await addRun({
        tool: TOOL,
        engineId: engine?.id ?? null,
        durationMs,
        input: {
          kind: "text",
          text: input,
          name: input.length > 40 ? `${input.slice(0, 40)}…` : input,
        },
        params: {},
        result: { text: punctuated } satisfies PunctuationResult,
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [text, busy, engine, addRun]);

  const restoreRun = useCallback((saved: PlaygroundRun) => {
    setText(saved.input.text ?? "");
    setRanText(saved.input.text ?? "");
    setOutput(resultText(saved));
    setError(null);
    setLastInfo(null);
    setSelectedRunId(saved.id);
  }, []);

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-y-auto p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-semibold text-xl">Punctuation</h1>
          <p className="text-muted-foreground text-sm">
            Restore punctuation and casing on raw transcript text, on-device.
          </p>
        </div>
        <EngineChip
          task="punctuation"
          override={engineOverride}
          onOverride={setEngineOverride}
        />
      </header>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        className="w-full resize-y rounded-md border border-input bg-transparent p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        placeholder="Paste raw, unpunctuated text…"
      />

      <div className="flex items-center gap-3">
        <Button onClick={run} size="sm" disabled={busy || !isDesktop() || !engine}>
          {busy ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <Type className="mr-1 h-4 w-4" />
          )}
          Punctuate
        </Button>
        {lastInfo && (
          <span className="text-muted-foreground text-xs">{lastInfo}</span>
        )}
      </div>

      {!isDesktop() && (
        <p className="text-muted-foreground text-sm">
          Local punctuation requires the desktop app.
        </p>
      )}
      {error && (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-destructive text-sm">
          {error}
        </p>
      )}

      {output !== null && (
        <div className="space-y-3 rounded-md border border-border bg-card p-4">
          <DiffView before={ranText} after={output} />
          <p className="border-border border-t pt-3 text-sm leading-relaxed">
            {output}
          </p>
        </div>
      )}

      <RecentRuns
        tool={TOOL}
        selectedId={selectedRunId}
        onSelect={restoreRun}
        summarize={(saved) => resultText(saved) || "—"}
      />
    </div>
  );
}

function DiffView({ before, after }: { before: string; after: string }) {
  const spans = diffWords(before, after);
  return (
    <p className="text-sm leading-relaxed">
      {spans.map((span, i) => (
        // Spans are a pure derivation of before/after; index identity is stable.
        // biome-ignore lint/suspicious/noArrayIndexKey: derived static list
        <span key={`${i}-${span.type}`}
          className={cn(
            span.type === "removed" &&
              "bg-destructive/10 text-muted-foreground line-through",
            span.type === "added" && "rounded-sm bg-primary/15",
          )}
        >
          {span.text}
          {i < spans.length - 1 ? " " : ""}
        </span>
      ))}
    </p>
  );
}
