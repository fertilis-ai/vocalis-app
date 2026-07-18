import { beforeEach, describe, expect, it } from "vitest";
import type { TtsVoice } from "@/lib/schemas/voices";
import { useVoicesStore } from "./voices-store";

// Store-logic tests: persistence goes through lib/storage, which no-ops
// outside Tauri (vitest included), so these cover the in-memory merging that
// pickers actually consume.

function voice(id: string, overrides: Partial<TtsVoice> = {}): TtsVoice {
  return {
    id,
    label: id,
    engineId: "local.kokoro-en",
    kind: "stock",
    langs: ["en"],
    params: {},
    favorite: false,
    ...overrides,
  };
}

describe("voices-store", () => {
  beforeEach(() => {
    useVoicesStore.setState({ voices: {}, loaded: false, view: "people" });
  });

  it("toggleFavorite seeds an entry on first touch and flips thereafter", async () => {
    const store = useVoicesStore.getState();
    await store.toggleFavorite(voice("local:kokoro-en-v0_19:1"));
    expect(useVoicesStore.getState().voices["local:kokoro-en-v0_19:1"].favorite).toBe(true);
    await useVoicesStore.getState().toggleFavorite(voice("local:kokoro-en-v0_19:1"));
    expect(useVoicesStore.getState().voices["local:kokoro-en-v0_19:1"].favorite).toBe(false);
  });

  it("setDefaultSpeed stores and clears the per-voice speed", async () => {
    await useVoicesStore.getState().setDefaultSpeed(voice("api:openai:alloy"), 1.25);
    expect(useVoicesStore.getState().voices["api:openai:alloy"].params.speed).toBe(1.25);
    await useVoicesStore.getState().setDefaultSpeed(voice("api:openai:alloy"), undefined);
    expect(useVoicesStore.getState().voices["api:openai:alloy"].params.speed).toBeUndefined();
  });

  it("syncClones upserts clone entries and prunes stale ones", async () => {
    const cloneA = voice("clone:zipvoice:a", { kind: "clone", personId: "a" });
    const cloneB = voice("clone:zipvoice:b", { kind: "clone", personId: "b" });
    await useVoicesStore.getState().syncClones([cloneA, cloneB]);
    expect(Object.keys(useVoicesStore.getState().voices).sort()).toEqual([
      "clone:zipvoice:a",
      "clone:zipvoice:b",
    ]);
    // Person b's clone disappears → its entry is pruned.
    await useVoicesStore.getState().syncClones([cloneA]);
    expect(Object.keys(useVoicesStore.getState().voices)).toEqual([
      "clone:zipvoice:a",
    ]);
  });

  it("syncClones preserves favorites and speed on surviving clones", async () => {
    const clone = voice("clone:zipvoice:a", { kind: "clone", personId: "a" });
    await useVoicesStore.getState().syncClones([clone]);
    await useVoicesStore.getState().toggleFavorite(clone);
    await useVoicesStore.getState().setDefaultSpeed(clone, 0.9);
    // Re-sync with a renamed person: label refreshes, user state survives.
    await useVoicesStore
      .getState()
      .syncClones([{ ...clone, label: "Renamed — clone (local)" }]);
    const entry = useVoicesStore.getState().voices["clone:zipvoice:a"];
    expect(entry.label).toBe("Renamed — clone (local)");
    expect(entry.favorite).toBe(true);
    expect(entry.params.speed).toBe(0.9);
  });

  it("syncClones leaves non-clone entries untouched", async () => {
    await useVoicesStore.getState().toggleFavorite(voice("api:openai:alloy"));
    await useVoicesStore
      .getState()
      .syncClones([voice("clone:zipvoice:a", { kind: "clone", personId: "a" })]);
    expect(useVoicesStore.getState().voices["api:openai:alloy"].favorite).toBe(true);
  });
});
