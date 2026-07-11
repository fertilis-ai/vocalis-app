import { useEffect, useMemo } from "react";
import type { SpeechTask } from "@/lib/engines/descriptors";
import {
  type EngineResolution,
  type RouterContext,
  resolveEngine,
} from "@/lib/routing/engine-router";
import { useModelsStore } from "@/stores/models-store";
import { useSettingsStore } from "@/stores/settings-store";

/**
 * Live router context from the settings + models stores. Components using it
 * re-render on privacy/routing/key/install changes, so every chip and picker
 * stays truthful without manual wiring.
 */
export function useRouterContext(): RouterContext {
  const privacyMode = useSettingsStore((s) => s.privacyMode);
  const routing = useSettingsStore((s) => s.routing);
  const apiKeys = useSettingsStore((s) => s.apiKeys);
  const installed = useModelsStore((s) => s.installed);
  const installedScanned = useModelsStore((s) => s.installedScanned);
  const loadInstalled = useModelsStore((s) => s.loadInstalled);

  // Eligibility needs the on-disk model list; scan once per app session.
  useEffect(() => {
    if (!installedScanned) void loadInstalled();
  }, [installedScanned, loadInstalled]);

  return useMemo(
    () => ({
      privacyMode,
      routing,
      apiProviders: new Set(
        Object.keys(apiKeys).filter((provider) => apiKeys[provider]),
      ),
      installedTasks: new Set(installed.map((model) => model.task)),
    }),
    [privacyMode, routing, apiKeys, installed],
  );
}

/** Resolve a task's engine reactively, honoring an inline override. */
export function useEngineResolution(
  task: SpeechTask,
  overrideId?: string | null,
): EngineResolution {
  const ctx = useRouterContext();
  return useMemo(() => resolveEngine(task, ctx, overrideId), [task, ctx, overrideId]);
}
