import * as React from "react";
import { FileAudio, Loader2, X } from "lucide-react";
import { EngineChip } from "@/components/shared/engine-chip";
import { Button } from "@/components/ui/button";
import { useEngineResolution, useRouterContext } from "@/lib/routing/use-engine";
import { type ImportHandle, type ImportProgress, runImport } from "@/lib/import/run-import";
import { useChatsCollection } from "@/stores/chats-collection";
import { useSessionStore } from "@/stores/session-store";

// The file-import dialog (spec §2.2B, M3 item 4). Opened from the chat "New…"
// flow after a file is chosen; lets the user confirm the source, override the
// batch-ASR engine (EngineChip, per spec §3.4), pick a language, and run the
// import. Creating the session is deferred to "Start" so cancelling leaves no
// empty session behind.

const LANGUAGES = [
  { value: "auto", label: "Auto-detect" },
  { value: "en", label: "English" },
  { value: "fr", label: "French" },
];

function baseName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

function titleFromFile(path: string): string {
  return baseName(path).replace(/\.[^.]+$/, "") || "Imported audio";
}

interface ImportDialogProps {
  filePath: string;
  onClose: () => void;
}

export function ImportDialog({ filePath, onClose }: ImportDialogProps) {
  const store = useChatsCollection();
  const ctx = useRouterContext();
  const [engineOverride, setEngineOverride] = React.useState<string | null>(null);
  const [language, setLanguage] = React.useState("auto");
  const [progress, setProgress] = React.useState<ImportProgress | null>(null);
  const handleRef = React.useRef<ImportHandle | null>(null);
  // The session/leaf created for this dialog's import, reused across "Try
  // again" retries so a failed attempt doesn't leave an orphaned duplicate.
  const sessionRef = React.useRef<{ id: string; title: string } | null>(null);

  const resolution = useEngineResolution("batchAsr", engineOverride);
  const engine = resolution.active;
  const running = progress !== null && progress.phase !== "error";
  const errored = progress?.phase === "error";

  async function start() {
    if (!engine) return;
    if (!sessionRef.current) {
      // Create the session only now, so a cancelled dialog leaves nothing behind.
      const title = titleFromFile(filePath);
      const node = await store.createLeaf("session", title);
      await useSessionStore.getState().createSession({
        id: node.id,
        title,
        mode: "import",
        engineId: engine.id,
      });
      store.select(node.id);
      sessionRef.current = { id: node.id, title };
    }
    const sessionId = sessionRef.current.id;

    setProgress({ phase: "normalizing", fraction: 0, message: "Decoding audio…" });
    try {
      const handle = runImport({
        sessionId,
        filePath,
        engineId: engine.id,
        ctx,
        language,
        onProgress: setProgress,
      });
      handleRef.current = handle;
      await handle.done;
      onClose();
    } catch {
      // The error phase is surfaced via onProgress; keep the dialog open.
    } finally {
      handleRef.current = null;
    }
  }

  async function cancel() {
    await handleRef.current?.cancel();
  }

  const pct = Math.round((progress?.fraction ?? 0) * 100);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg border border-border bg-background p-5 shadow-lg">
        <div className="mb-4 flex items-start justify-between">
          <div className="flex items-center gap-2">
            <FileAudio className="h-5 w-5 text-muted-foreground" />
            <div>
              <h2 className="font-medium text-sm">Import audio</h2>
              <p className="max-w-[18rem] truncate text-muted-foreground text-xs">
                {baseName(filePath)}
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            className="h-6 w-6"
            onClick={onClose}
            disabled={running}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {progress ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              {running && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              <span className={errored ? "text-destructive" : "text-muted-foreground"}>
                {errored
                  ? (progress.error ?? "Import failed")
                  : (progress.message ?? phaseLabel(progress.phase))}
              </span>
            </div>
            {!errored && (
              <>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-primary transition-[width]"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="flex justify-end">
                  <Button variant="ghost" size="sm" onClick={() => void cancel()}>
                    Cancel
                  </Button>
                </div>
              </>
            )}
            {errored && (
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={onClose}>
                  Close
                </Button>
                <Button size="sm" onClick={() => setProgress(null)}>
                  Try again
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-xs">Engine</span>
              <EngineChip
                task="batchAsr"
                override={engineOverride}
                onOverride={setEngineOverride}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-xs">Language</span>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="rounded-md border border-border bg-background px-2 py-1 text-xs"
              >
                {LANGUAGES.map((lang) => (
                  <option key={lang.value} value={lang.value}>
                    {lang.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void start()} disabled={!engine}>
                {engine ? "Start import" : "No engine available"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function phaseLabel(phase: ImportProgress["phase"]): string {
  switch (phase) {
    case "normalizing":
      return "Decoding audio…";
    case "transcribing":
      return "Transcribing…";
    case "complete":
      return "Done";
    default:
      return "";
  }
}
