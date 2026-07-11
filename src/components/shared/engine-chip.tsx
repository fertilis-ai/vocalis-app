import { Check, Cloud, Lock, Zap } from "lucide-react";
import type { EngineDescriptor, SpeechTask } from "@/lib/engines/descriptors";
import { REASON_LABELS } from "@/lib/routing/engine-router";
import { useEngineResolution } from "@/lib/routing/use-engine";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// The persistent engine indicator (spec §2.1): every surface that runs speech
// shows which engine will serve it, clickable to override for that context.
// Rendered from the router so the chip can never disagree with what runs.

interface EngineChipProps {
  task: SpeechTask;
  /** Inline override for this context (null/undefined = task default) */
  override?: string | null;
  onOverride?: (engineId: string | null) => void;
  className?: string;
}

function KindIcon({ engine, locked }: { engine: EngineDescriptor | null; locked: boolean }) {
  if (locked) return <Lock className="h-3 w-3" />;
  if (engine?.kind === "api") return <Cloud className="h-3 w-3" />;
  return <Zap className="h-3 w-3" />;
}

export function EngineChip({ task, override, onOverride, className }: EngineChipProps) {
  const resolution = useEngineResolution(task, override);
  const { active, options } = resolution;
  const privacyMode = useSettingsStore((s) => s.privacyMode);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex items-center gap-1 rounded-full border border-border px-2 py-1 text-xs transition-colors hover:bg-accent",
          active ? "text-muted-foreground" : "border-destructive/50 text-destructive",
          className,
        )}
      >
        <KindIcon engine={active} locked={privacyMode} />
        {active
          ? active.label
          : `no engine — ${resolution.reason ? REASON_LABELS[resolution.reason] : "none eligible"}`}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Engine for this run</DropdownMenuLabel>
        {options.map((option) => {
          const isActive = option.engine.id === active?.id;
          return (
            <DropdownMenuItem
              key={option.engine.id}
              disabled={!option.eligible}
              onClick={() =>
                onOverride?.(option.isDefault ? null : option.engine.id)
              }
            >
              {option.engine.kind === "api" ? (
                <Cloud className="h-3.5 w-3.5" />
              ) : (
                <Zap className="h-3.5 w-3.5" />
              )}
              <span className="flex-1 truncate">
                {option.engine.label}
                {option.isDefault && (
                  <span className="ml-1 text-muted-foreground text-xs">default</span>
                )}
              </span>
              {option.reason && (
                <span className="text-muted-foreground text-xs">
                  {REASON_LABELS[option.reason]}
                </span>
              )}
              {isActive && <Check className="h-3.5 w-3.5" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
