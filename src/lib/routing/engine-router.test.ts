import { describe, expect, it } from "vitest";
import { DEFAULT_ROUTING, ROUTING_TASKS } from "@/lib/schemas/config";
import {
  ENGINE_DESCRIPTORS,
  enginesForTask,
  SPEECH_TASKS,
} from "@/lib/engines/descriptors";
import {
  evaluateEngine,
  resolveEngine,
  type RouterContext,
  taskOptions,
} from "./engine-router";

function ctx(overrides: Partial<RouterContext> = {}): RouterContext {
  return {
    privacyMode: false,
    routing: { ...DEFAULT_ROUTING },
    apiProviders: new Set(),
    installedTasks: new Set(),
    installedModels: [],
    ...overrides,
  };
}

describe("descriptors", () => {
  it("covers every speech task", () => {
    for (const task of SPEECH_TASKS) {
      expect(enginesForTask(task).length, task).toBeGreaterThan(0);
    }
  });

  it("gives every task at least one local engine", () => {
    for (const task of SPEECH_TASKS) {
      expect(
        enginesForTask(task).some((e) => e.kind === "local"),
        task,
      ).toBe(true);
    }
  });

  it("matches the config routing defaults", () => {
    for (const task of ROUTING_TASKS) {
      expect(
        enginesForTask(task).map((e) => e.id),
        task,
      ).toContain(DEFAULT_ROUTING[task]);
    }
  });

  it("has unique ids within each task", () => {
    for (const task of SPEECH_TASKS) {
      const ids = enginesForTask(task).map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("declares a provider on every API engine and a modelTask on every local one", () => {
    for (const engine of ENGINE_DESCRIPTORS) {
      if (engine.kind === "api") expect(engine.provider, engine.id).toBeDefined();
      else expect(engine.modelTask, engine.id).toBeDefined();
    }
  });
});

describe("evaluateEngine", () => {
  const zipformer = enginesForTask("streamingAsr").find((e) => e.kind === "local");
  const deepgram = enginesForTask("streamingAsr").find((e) => e.kind === "api");
  const kokoro = enginesForTask("tts").find((e) => e.id === "local.kokoro-en");
  if (!zipformer || !deepgram || !kokoro) throw new Error("descriptor missing");

  it("marks local engines without an installed model as not-installed", () => {
    expect(evaluateEngine(zipformer, ctx())).toEqual({
      eligible: false,
      reason: "not-installed",
    });
  });

  it("accepts local engines once a model for their task is installed", () => {
    expect(
      evaluateEngine(zipformer, ctx({ installedTasks: new Set(["asr-streaming"]) })),
    ).toEqual({ eligible: true });
  });

  it("hard-filters API engines in privacy mode", () => {
    expect(
      evaluateEngine(deepgram, ctx({ privacyMode: true, apiProviders: new Set(["deepgram"]) })),
    ).toEqual({ eligible: false, reason: "privacy" });
  });

  it("requires an API key outside privacy mode", () => {
    // deepgram.nova (streaming) is still unimplemented (M2 item 9 deferred WS),
    // so use a synthetic implemented copy to observe the key check in isolation.
    const implemented = { ...deepgram, implemented: true };
    expect(evaluateEngine(implemented, ctx())).toEqual({ eligible: false, reason: "no-key" });
    expect(
      evaluateEngine(implemented, ctx({ apiProviders: new Set(["deepgram"]) })),
    ).toEqual({ eligible: true });
  });

  it("flags unimplemented engines before anything else", () => {
    // deepgram.nova streaming stays unimplemented until the WebSocket path lands.
    expect(
      evaluateEngine(deepgram, ctx({ apiProviders: new Set(["deepgram"]) })),
    ).toEqual({ eligible: false, reason: "not-implemented" });
  });

  it("accepts an implemented local engine with its model installed", () => {
    expect(evaluateEngine(kokoro, ctx({ installedTasks: new Set(["tts"]) }))).toEqual({
      eligible: true,
    });
  });
});

describe("resolveEngine", () => {
  const installedAll = new Set(["asr-streaming", "vad", "tts", "punctuation"]);

  it("resolves the configured default when eligible", () => {
    const resolution = resolveEngine("tts", ctx({ installedTasks: installedAll }));
    expect(resolution.active?.id).toBe("local.kokoro-en");
    expect(resolution.isOverride).toBe(false);
  });

  it("prefers an eligible override over the default", () => {
    // Pretend routing points somewhere else; the override should win.
    const resolution = resolveEngine(
      "streamingAsr",
      ctx({ installedTasks: installedAll }),
      "local.zipformer-en",
    );
    expect(resolution.active?.id).toBe("local.zipformer-en");
    expect(resolution.isOverride).toBe(true);
  });

  it("falls back to the default when the override is ineligible, and says why", () => {
    const resolution = resolveEngine(
      "streamingAsr",
      ctx({ installedTasks: installedAll }),
      "deepgram.nova",
    );
    expect(resolution.active?.id).toBe("local.zipformer-en");
    expect(resolution.isOverride).toBe(false);
    expect(resolution.reason).toBe("not-implemented");
  });

  it("never falls back toward an API engine", () => {
    // No local model installed, Deepgram key present: resolution must NOT
    // silently pick the API engine.
    const resolution = resolveEngine(
      "streamingAsr",
      ctx({ apiProviders: new Set(["deepgram"]) }),
    );
    expect(resolution.active).toBeNull();
    expect(resolution.reason).toBe("not-installed");
  });

  it("returns null with a reason when nothing serves the task", () => {
    const resolution = resolveEngine("cloneTts", ctx());
    expect(resolution.active).toBeNull();
    expect(resolution.reason).toBe("not-implemented");
  });

  it("resolves local-only tasks without a routing entry", () => {
    const resolution = resolveEngine("vad", ctx({ installedTasks: installedAll }));
    expect(resolution.active?.id).toBe("local.silero-vad");
  });

  it("lists every engine as an option with its own eligibility", () => {
    const options = taskOptions(
      "streamingAsr",
      ctx({ privacyMode: true, installedTasks: installedAll }),
    );
    expect(options).toHaveLength(2);
    const api = options.find((o) => o.engine.kind === "api");
    // Privacy outranks every other ineligibility reason.
    expect(api?.reason).toBe("privacy");
    const local = options.find((o) => o.engine.kind === "local");
    expect(local?.eligible).toBe(true);
    expect(local?.isDefault).toBe(true);
  });

  it("treats an unknown configured engine id as no default", () => {
    const resolution = resolveEngine(
      "tts",
      ctx({
        routing: { ...DEFAULT_ROUTING, tts: "local.borked" },
        installedTasks: installedAll,
      }),
    );
    // Hand-edited config pointing nowhere degrades to the local fallback.
    expect(resolution.active?.id).toBe("local.kokoro-en");
  });

  it("lists every installed model for a local engine's modelTask, not just one", () => {
    // Two downloaded asr-batch models (spec bug: only one hardcoded row showed).
    const installedModels = [
      { task: "asr-batch", id: "whisper-small-int8", sizeBytes: 1 },
      { task: "asr-batch", id: "parakeet-tdt-0.6b-v3-int8", sizeBytes: 1 },
    ];
    const options = taskOptions(
      "batchAsr",
      ctx({
        installedTasks: new Set(["asr-batch"]),
        installedModels,
      }),
    );
    const local = options.find((o) => o.engine.kind === "local");
    expect(local?.models.map((m) => m.id)).toEqual([
      "whisper-small-int8",
      "parakeet-tdt-0.6b-v3-int8",
    ]);
  });

  it("gives a local engine no models when its modelTask has none installed", () => {
    const options = taskOptions("streamingAsr", ctx());
    const local = options.find((o) => o.engine.kind === "local");
    expect(local?.models).toEqual([]);
  });
});
