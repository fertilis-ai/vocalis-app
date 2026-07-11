import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePollingLoader } from "./use-polling-loader";

describe("usePollingLoader", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls loadFn immediately on mount", () => {
    const loadFn = vi.fn();
    renderHook(() => usePollingLoader(loadFn));
    expect(loadFn).toHaveBeenCalledTimes(1);
  });

  it("calls loadFn at the default interval (5000ms)", () => {
    const loadFn = vi.fn();
    renderHook(() => usePollingLoader(loadFn));

    expect(loadFn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5000);
    expect(loadFn).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(5000);
    expect(loadFn).toHaveBeenCalledTimes(3);
  });

  it("uses a custom interval", () => {
    const loadFn = vi.fn();
    renderHook(() => usePollingLoader(loadFn, 2000));

    expect(loadFn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);
    expect(loadFn).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(2000);
    expect(loadFn).toHaveBeenCalledTimes(3);
  });

  it("does not call between intervals", () => {
    const loadFn = vi.fn();
    renderHook(() => usePollingLoader(loadFn, 3000));

    expect(loadFn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2999);
    expect(loadFn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(loadFn).toHaveBeenCalledTimes(2);
  });

  it("clears interval on unmount", () => {
    const loadFn = vi.fn();
    const { unmount } = renderHook(() => usePollingLoader(loadFn, 1000));

    expect(loadFn).toHaveBeenCalledTimes(1);

    unmount();

    vi.advanceTimersByTime(5000);
    expect(loadFn).toHaveBeenCalledTimes(1);
  });

  it("restarts polling when loadFn changes", () => {
    const loadFn1 = vi.fn();
    const loadFn2 = vi.fn();

    const { rerender } = renderHook(
      ({ fn }) => usePollingLoader(fn, 1000),
      { initialProps: { fn: loadFn1 } }
    );

    expect(loadFn1).toHaveBeenCalledTimes(1);

    rerender({ fn: loadFn2 });
    // loadFn2 called immediately by the new effect
    expect(loadFn2).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(loadFn2).toHaveBeenCalledTimes(2);
    // loadFn1 should not be called again after the switch
    expect(loadFn1).toHaveBeenCalledTimes(1);
  });
});
