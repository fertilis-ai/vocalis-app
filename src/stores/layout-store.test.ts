import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock zustand persist to be a passthrough (avoids localStorage issues in tests)
vi.mock("zustand/middleware", () => ({
  persist: (fn: unknown) => fn,
}));

import { useLayoutStore } from "./layout-store";

describe("layout-store", () => {
  beforeEach(() => {
    useLayoutStore.setState({
      openSection: null,
      paneWidths: {
        chat: 250,
        playground: 250,
        voices: 250,
        models: 250,
        settings: 300,
        debug: 250,
      },
    });
  });

  it("toggles a section open and closed", () => {
    useLayoutStore.getState().toggleSection("playground");
    expect(useLayoutStore.getState().openSection).toBe("playground");

    useLayoutStore.getState().toggleSection("playground");
    expect(useLayoutStore.getState().openSection).toBeNull();
  });

  it("switches directly between sections", () => {
    useLayoutStore.getState().toggleSection("chat");
    useLayoutStore.getState().toggleSection("models");
    expect(useLayoutStore.getState().openSection).toBe("models");
  });

  it("openSectionPane always opens", () => {
    useLayoutStore.getState().openSectionPane("voices");
    useLayoutStore.getState().openSectionPane("voices");
    expect(useLayoutStore.getState().openSection).toBe("voices");
  });

  it("closePane closes any open pane", () => {
    useLayoutStore.getState().openSectionPane("settings");
    useLayoutStore.getState().closePane();
    expect(useLayoutStore.getState().openSection).toBeNull();
  });

  it("setPaneWidth updates only the given section", () => {
    useLayoutStore.getState().setPaneWidth("chat", 320);
    const { paneWidths } = useLayoutStore.getState();
    expect(paneWidths.chat).toBe(320);
    expect(paneWidths.models).toBe(250);
  });
});
