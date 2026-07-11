import { Check, Cloud, Lock, Zap } from "lucide-react";
import type { EngineDescriptor, SpeechTask } from "@/lib/engines/descriptors";
import { type EngineOption, REASON_LABELS } from "@/lib/routing/engine-router";
import { useEngineResolution } from "@/lib/routing/use-engine";
import type { Catalog, InstalledModel } from "@/lib/schemas/catalog";
import { cn } from "@/lib/utils";
import { useModelsStore } from "@/stores/models-store";
import { useSettingsStore } from "@/stores/settings-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// A local engine's modelTask can have more than one downloaded model (e.g.
// two installed batch-ASR models); the chip lists each by name instead of
// collapsing them behind the engine's generic label.
function modelLabel(model: InstalledModel, catalog: Catalog | null): string {
  if (model.custom) return model.name ?? model.id;
  return catalog?.models.find((m) => m.id === model.id)?.name ?? model.id;
}

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

/** One selectable row: an engine on its own, or one of its installed models. */
function OptionRow({
  option,
  model,
  isActive,
  showDefaultTag,
  onSelect,
}: {
  option: EngineOption;
  model: InstalledModel | null;
  isActive: boolean;
  showDefaultTag: boolean;
  onSelect: () => void;
}) {
  const catalog = useModelsStore((s) => s.catalog);
  return (
    <DropdownMenuItem disabled={!option.eligible} onClick={onSelect}>
      {option.engine.kind === "api" ? (
        <Cloud className="h-3.5 w-3.5" />
      ) : (
        <Zap className="h-3.5 w-3.5" />
      )}
      <span className="flex-1 truncate">
        {model ? modelLabel(model, catalog) : option.engine.label}
        {showDefaultTag && (
          <span className="ml-1 text-muted-foreground text-xs">default</span>
        )}
      </span>
      {option.reason && (
        <span className="text-muted-foreground text-xs">{REASON_LABELS[option.reason]}</span>
      )}
      {isActive && <Check className="h-3.5 w-3.5" />}
    </DropdownMenuItem>
  );
}

export function EngineChip({ task, override, onOverride, className }: EngineChipProps) {
  const resolution = useEngineResolution(task, override);
  const { active, options } = resolution;
  const privacyMode = useSettingsStore((s) => s.privacyMode);
  const activeByTask = useSettingsStore((s) => s.activeByTask);
  const setActiveModel = useSettingsStore((s) => s.setActiveModel);
  const catalog = useModelsStore((s) => s.catalog);

  const activeOption = options.find((option) => option.engine.id === active?.id);
  const activeModelTask = active?.modelTask;
  const activeModel =
    activeModelTask && activeOption
      ? (activeOption.models.find((m) => m.id === activeByTask[activeModelTask]) ??
        (activeOption.models.length === 1 && activeByTask[activeModelTask] == null
          ? activeOption.models[0]
          : undefined))
      : undefined;
  const triggerLabel = active
    ? activeModel
      ? modelLabel(activeModel, catalog)
      : active.label
    : `no engine — ${resolution.reason ? REASON_LABELS[resolution.reason] : "none eligible"}`;

  const selectEngine = (option: (typeof options)[number], modelId?: string) => {
    onOverride?.(option.isDefault ? null : option.engine.id);
    if (option.engine.modelTask && modelId) {
      setActiveModel(option.engine.modelTask, modelId);
    }
  };

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
        {triggerLabel}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Engine for this run</DropdownMenuLabel>
          {options.flatMap((option) => {
            if (option.models.length > 0) {
              const isEngineActive = option.engine.id === active?.id;
              // No explicit activeByTask entry with exactly one installed
              // model: Rust's fallback (first installed) resolves to it, so
              // treat it as active rather than showing no selection at all.
              const impliedSingle =
                option.models.length === 1 &&
                option.engine.modelTask != null &&
                activeByTask[option.engine.modelTask] == null;
              return option.models.map((model) => (
                <OptionRow
                  key={`${option.engine.id}:${model.id}`}
                  option={option}
                  model={model}
                  isActive={
                    isEngineActive && (model.id === activeModel?.id || impliedSingle)
                  }
                  showDefaultTag={option.isDefault && option.models.length === 1}
                  onSelect={() => selectEngine(option, model.id)}
                />
              ));
            }
            return [
              <OptionRow
                key={option.engine.id}
                option={option}
                model={null}
                isActive={option.engine.id === active?.id}
                showDefaultTag={option.isDefault}
                onSelect={() => selectEngine(option)}
              />,
            ];
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
