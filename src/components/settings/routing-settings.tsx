import { Check, ChevronDown, Cloud, Lock, Waypoints, Zap } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TASK_LABELS } from "@/lib/engines/descriptors";
import { REASON_LABELS, taskOptions } from "@/lib/routing/engine-router";
import { useRouterContext } from "@/lib/routing/use-engine";
import { ROUTING_TASKS, type RoutingTask } from "@/lib/schemas/config";
import { useSettingsStore } from "@/stores/settings-store";
import { SettingsSection } from "./settings-section";

// The per-task default matrix (spec §3.4). Only the hybrid tasks are
// routable; everything else runs locally in v1. Defaults may point at
// engines that are currently ineligible (no key / model missing) — the
// runtime router degrades to a local engine and the chip shows it.

function TaskRow({ task }: { task: RoutingTask }) {
  const ctx = useRouterContext();
  const setTaskEngine = useSettingsStore((s) => s.setTaskEngine);
  const options = taskOptions(task, ctx);
  const selected = options.find((option) => option.isDefault);

  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm">{TASK_LABELS[task]}</span>
      <DropdownMenu>
        <DropdownMenuTrigger className="flex w-64 items-center gap-2 rounded-md border border-input px-3 py-1.5 text-sm transition-colors hover:bg-accent">
          {selected?.engine.kind === "api" ? (
            <Cloud className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <Zap className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <span className="flex-1 truncate text-left">
            {selected?.engine.label ?? ctx.routing[task] ?? "—"}
          </span>
          {selected && !selected.eligible && selected.reason && (
            <span className="text-muted-foreground text-xs">
              {REASON_LABELS[selected.reason]}
            </span>
          )}
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          {options.map((option) => (
            <DropdownMenuItem
              disabled={option.reason === "not-implemented" || option.reason === "privacy"}
              key={option.engine.id}
              onClick={() => setTaskEngine(task, option.engine.id)}
            >
              {option.engine.kind === "api" ? (
                <Cloud className="h-3.5 w-3.5" />
              ) : (
                <Zap className="h-3.5 w-3.5" />
              )}
              <span className="flex-1 truncate">{option.engine.label}</span>
              {option.reason && (
                <span className="text-muted-foreground text-xs">
                  {REASON_LABELS[option.reason]}
                </span>
              )}
              {option.isDefault && <Check className="h-3.5 w-3.5" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function RoutingSettings() {
  const privacyMode = useSettingsStore((s) => s.privacyMode);
  const setPrivacyMode = useSettingsStore((s) => s.setPrivacyMode);

  return (
    <SettingsSection icon={Waypoints} id="routing" title="Engines & Routing">
      <div className="space-y-6">
        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <Checkbox
            checked={privacyMode}
            className="mt-0.5"
            onCheckedChange={(checked) => setPrivacyMode(checked === true)}
          />
          <span>
            <span className="flex items-center gap-1.5 font-medium">
              <Lock className="h-3.5 w-3.5" /> Privacy mode
            </span>
            <span className="text-muted-foreground">
              Hard-disables every API engine. Speech never leaves this Mac while it's on.
            </span>
          </span>
        </label>

        <div className="space-y-3">
          {ROUTING_TASKS.map((task) => (
            <TaskRow key={task} task={task} />
          ))}
        </div>
        <p className="text-muted-foreground text-xs">
          These are the defaults; every speech surface shows an engine chip that can
          override them in place. VAD, speaker ID/verification, punctuation, keyword
          spotting, source separation, and language ID always run locally in v1.
        </p>
      </div>
    </SettingsSection>
  );
}
