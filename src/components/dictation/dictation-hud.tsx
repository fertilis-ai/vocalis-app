import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Check, Clipboard, Mic, Sparkles, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { recordDictation } from "@/lib/dictation/history";
import { polishDictation } from "@/lib/llm/dictation-polish";
import {
  cancelDictation,
  finalizeDictation,
  injectText,
  type PipelineEvent,
  startDictation,
} from "@/lib/engines/local";
import { useSettingsStore } from "@/stores/settings-store";

type HudStatus = "idle" | "listening" | "finalizing" | "complete" | "error";
type HotkeyEvent = { state: "pressed" | "released" | "cancel"; mode: "hold" | "toggle" };

export function DictationHud() {
  const [status, setStatus] = useState<HudStatus>("idle");
  const [partial, setPartial] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pipelineId = useRef<number | null>(null);
  const releasePending = useRef(false);
  const isStarting = useRef(false);
  const startRef = useRef<() => void>(() => {});
  const finalizeRef = useRef<() => void>(() => {});
  const cancelRef = useRef<() => void>(() => {});
  const polish = useSettingsStore((state) => state.dictation.polish);
  const polishModel = useSettingsStore((state) => state.dictation.polishModel);
  const privacyMode = useSettingsStore((state) => state.privacyMode);
  const apiKeys = useSettingsStore((state) => state.apiKeys);
  const historyEnabled = useSettingsStore((state) => state.dictation.historyEnabled);
  const asrModel = useSettingsStore((state) => state.activeByTask["asr-streaming"]);

  const hide = useCallback(() => {
    void getCurrentWindow().hide();
  }, []);

  const cancel = useCallback(async () => {
    const id = pipelineId.current;
    pipelineId.current = null;
    releasePending.current = false;
    isStarting.current = false;
    if (id !== null) {
      await cancelDictation(id).catch(() => {});
    }
    setStatus("idle");
    setPartial("");
    setSpeaking(false);
    hide();
  }, [hide]);

  const finalize = useCallback(async () => {
    const id = pipelineId.current;
    if (id === null || status === "finalizing") return;
    setStatus("finalizing");
    try {
      const punctuatedText = await finalizeDictation(id);
      pipelineId.current = null;
      isStarting.current = false;
      const text = polish
        ? await polishDictation(punctuatedText, { apiKeys, model: polishModel, privacyMode })
        : punctuatedText;
      setPartial(text || "No speech detected");
      if (text.trim()) {
        // A mouse click on Finish focuses the HUD. Hide it before synthesizing
        // Cmd+V so macOS restores focus to the app that received the dictation.
        await getCurrentWindow().hide();
        const injection = await injectText(text);
        if (historyEnabled && injection.copied) await recordDictation(text);
      }
      setStatus("complete");
      window.setTimeout(hide, 700);
    } catch (reason) {
      pipelineId.current = null;
      isStarting.current = false;
      setError(String(reason));
      setStatus("error");
    }
  }, [apiKeys, hide, historyEnabled, polish, polishModel, privacyMode, status]);

  const onPipelineEvent = useCallback((event: PipelineEvent) => {
    switch (event.type) {
      case "partial":
      case "final":
        setPartial(event.text);
        break;
      case "vadState":
        setSpeaking(event.speaking);
        break;
      case "error":
        setError(event.message);
        setStatus("error");
        pipelineId.current = null;
        isStarting.current = false;
        break;
      case "stopped":
        setSpeaking(false);
        break;
      default:
        break;
    }
  }, []);

  const start = useCallback(async () => {
    if (pipelineId.current !== null || isStarting.current) return;
    isStarting.current = true;
    setError(null);
    setPartial("");
    setStatus("listening");
    try {
      const id = await startDictation({ onEvent: onPipelineEvent });
      pipelineId.current = id;
      isStarting.current = false;
      if (releasePending.current) {
        releasePending.current = false;
        void finalize();
      }
    } catch (reason) {
      setError(String(reason));
      setStatus("error");
      isStarting.current = false;
    }
  }, [finalize, onPipelineEvent]);

  // The global shortcut listener is registered exactly once. These refs keep
  // it pointed at the latest callbacks without a release event being lost in
  // the render/effect cleanup gap immediately after a key press.
  startRef.current = () => void start();
  finalizeRef.current = () => void finalize();
  cancelRef.current = () => void cancel();

  useEffect(() => {
    document.documentElement.classList.add("dictation-hud-window");
    document.body.classList.add("dictation-hud-window");
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<HotkeyEvent>("dictation-hotkey", ({ payload }) => {
      if (payload.state === "cancel") {
        cancelRef.current();
        return;
      }
      if (payload.mode === "toggle") {
        if (pipelineId.current === null) startRef.current();
        else finalizeRef.current();
        return;
      }
      if (payload.state === "pressed") startRef.current();
      else if (pipelineId.current === null || isStarting.current) releasePending.current = true;
      else finalizeRef.current();
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("keydown", onKeyDown);
      document.documentElement.classList.remove("dictation-hud-window");
      document.body.classList.remove("dictation-hud-window");
    };
  }, []);

  const listening = status === "listening";
  const complete = status === "complete";

  return (
    <main className="flex h-svh items-center p-3 text-foreground">
      <section className="relative flex h-full w-full items-center gap-4 overflow-hidden rounded-2xl border border-border bg-popover/95 px-5 shadow-lg backdrop-blur-xl">
        <div className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10">
          {complete ? <Check className="h-5 w-5 text-primary" /> : <Mic className="h-5 w-5 text-primary" />}
          {listening && <span className="absolute inset-0 animate-ping rounded-xl border border-primary/30" />}
        </div>

        <div className="relative min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            <span>{complete ? "sent" : status === "finalizing" ? "finishing" : listening ? "dictating" : "ready"}</span>
            <span className="h-1 w-1 rounded-full bg-muted-foreground/50" />
            <span>local · {asrModel ?? "zipformer"}</span>
            <span className="ml-1 flex h-3 items-center gap-0.5" title={speaking ? "Speech detected" : "Listening"}>
              {[0, 1, 2, 3].map((bar) => (
                <i
                  className={`w-0.5 rounded-full bg-primary transition-all ${speaking ? "animate-pulse" : "h-1 opacity-30"}`}
                  key={bar}
                  style={speaking ? { animationDelay: `${bar * 90}ms`, height: `${5 + bar * 2}px` } : undefined}
                />
              ))}
            </span>
          </div>
          <p
            className={`min-h-12 truncate font-medium text-[15px] leading-6 ${error ? "text-destructive" : "text-foreground"}`}
          >
            {error || partial || "Hold ⌥ Space and speak · ⌥ Esc cancels"}
          </p>
        </div>

        <div className="relative flex items-center gap-2">
          <button
            className={`flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors ${polish ? "border-primary/40 bg-primary/15 text-primary" : "border-border bg-muted/50 text-muted-foreground"}`}
            onClick={() => void emit("dictation-settings", { togglePolish: true })}
            title="Toggle LLM polish"
            type="button"
          >
            <Sparkles className="h-3.5 w-3.5" /> Polish
          </button>
          {listening && (
            <Button
              aria-label="Finish dictation"
              className="h-9 rounded-full border border-primary/25 bg-primary/10 px-3 text-primary hover:bg-primary/20"
              onClick={() => void finalize()}
              variant="ghost"
            >
              <Square className="mr-1.5 h-3.5 w-3.5 fill-current" /> Finish
            </Button>
          )}
          <Button
            aria-label="Cancel dictation"
            className="h-9 w-9 rounded-full border border-border bg-muted/50 p-0 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => void cancel()}
            variant="ghost"
          >
            {complete ? <Clipboard className="h-4 w-4" /> : <X className="h-4 w-4" />}
          </Button>
        </div>
      </section>
    </main>
  );
}
