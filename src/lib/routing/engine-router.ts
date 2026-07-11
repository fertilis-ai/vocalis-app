// Engine router — spec §3.4. Resolves (task, override?, context) to the
// active engine plus per-engine eligibility, so chips, pickers, and the
// settings matrix all render from the same answer. Pure functions: the
// context is assembled from the stores by lib/routing/use-engine.ts.
//
// The one hard rule: resolution never falls back *toward* an API engine.
// Privacy mode filters `kind: "api"` out entirely; an ineligible API default
// degrades to a local engine (visibly — the chip changes), never the reverse.

import {
  DEFAULT_ROUTING,
  type RoutingTask,
  ROUTING_TASKS,
} from "@/lib/schemas/config";
import {
  type EngineDescriptor,
  enginesForTask,
  findEngine,
  type SpeechTask,
} from "@/lib/engines/descriptors";

export type IneligibleReason =
  | "not-implemented"
  | "privacy"
  | "no-key"
  | "not-installed";

export const REASON_LABELS: Record<IneligibleReason, string> = {
  "not-implemented": "not available yet",
  privacy: "privacy mode",
  "no-key": "no API key",
  "not-installed": "model not downloaded",
};

export interface RouterContext {
  privacyMode: boolean;
  /** task -> configured default engineId (config routing map) */
  routing: Record<string, string>;
  /** providers with an API key configured */
  apiProviders: ReadonlySet<string>;
  /** model-registry tasks with at least one installed model */
  installedTasks: ReadonlySet<string>;
}

export interface EngineOption {
  engine: EngineDescriptor;
  eligible: boolean;
  reason?: IneligibleReason;
  /** true when this engine is the task's configured (or implicit) default */
  isDefault: boolean;
}

export interface EngineResolution {
  task: SpeechTask;
  /** engine speech should run on; null when nothing eligible serves the task */
  active: EngineDescriptor | null;
  /** why active is null or degraded from the requested engine, when it is */
  reason?: IneligibleReason;
  /** true when active came from an explicit override rather than the default */
  isOverride: boolean;
  options: EngineOption[];
}

export function evaluateEngine(
  engine: EngineDescriptor,
  ctx: RouterContext,
): { eligible: boolean; reason?: IneligibleReason } {
  // Privacy is the hard guarantee, so it outranks every other reason.
  if (engine.kind === "api" && ctx.privacyMode) {
    return { eligible: false, reason: "privacy" };
  }
  if (!engine.implemented) return { eligible: false, reason: "not-implemented" };
  if (engine.kind === "api") {
    if (!engine.provider || !ctx.apiProviders.has(engine.provider)) {
      return { eligible: false, reason: "no-key" };
    }
    return { eligible: true };
  }
  if (engine.modelTask && !ctx.installedTasks.has(engine.modelTask)) {
    return { eligible: false, reason: "not-installed" };
  }
  return { eligible: true };
}

/** The configured default for a task; local-only tasks default to their
 *  single local engine without a config entry. */
export function defaultEngineId(task: SpeechTask, ctx: RouterContext): string | undefined {
  if ((ROUTING_TASKS as readonly string[]).includes(task)) {
    return ctx.routing[task] ?? DEFAULT_ROUTING[task as RoutingTask];
  }
  return enginesForTask(task).find((engine) => engine.kind === "local")?.id;
}

export function taskOptions(task: SpeechTask, ctx: RouterContext): EngineOption[] {
  const defaultId = defaultEngineId(task, ctx);
  return enginesForTask(task).map((engine) => ({
    engine,
    ...evaluateEngine(engine, ctx),
    isDefault: engine.id === defaultId,
  }));
}

/**
 * Resolve the engine a task should run on right now.
 * Order: eligible override → eligible configured default → first eligible
 * LOCAL engine (an API engine is never a fallback) → null.
 */
export function resolveEngine(
  task: SpeechTask,
  ctx: RouterContext,
  overrideId?: string | null,
): EngineResolution {
  const options = taskOptions(task, ctx);
  const eligibility = (id: string | undefined) =>
    options.find((option) => option.engine.id === id);

  if (overrideId) {
    const option = eligibility(overrideId);
    if (option?.eligible) {
      return { task, active: option.engine, isOverride: true, options };
    }
  }

  const wanted = overrideId ?? defaultEngineId(task, ctx);
  const defaultOption = options.find((option) => option.isDefault);
  if (defaultOption?.eligible) {
    return {
      task,
      active: defaultOption.engine,
      // Reaching the default because an override was ineligible is a
      // degradation worth surfacing.
      reason: overrideId ? eligibility(overrideId)?.reason : undefined,
      isOverride: false,
      options,
    };
  }

  const localFallback = options.find(
    (option) => option.eligible && option.engine.kind === "local",
  );
  const reason = eligibility(wanted)?.reason ?? defaultOption?.reason;
  return {
    task,
    active: localFallback?.engine ?? null,
    reason,
    isOverride: false,
    options,
  };
}

/** Unknown engine ids (hand-edited config) resolve like a missing default. */
export function isKnownEngine(task: SpeechTask, id: string): boolean {
  return findEngine(task, id) !== undefined;
}
