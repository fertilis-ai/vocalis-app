import { describe, expect, it, vi } from "vitest";
import { createPlaybackQueue, type PlaybackQueueDeps } from "./playback-queue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function makeDeps(overrides: Partial<PlaybackQueueDeps> = {}) {
  const activeCalls: boolean[] = [];
  const playedPaths: string[] = [];
  const stops = vi.fn();
  const playDeferreds: ReturnType<typeof deferred<void>>[] = [];

  const deps: PlaybackQueueDeps = {
    synthesize: vi.fn(async (text: string) => ({ path: text })),
    play: vi.fn((path: string) => {
      playedPaths.push(path);
      const d = deferred<void>();
      playDeferreds.push(d);
      return {
        done: d.promise,
        stop: () => {
          stops(path);
          d.resolve();
        },
      };
    }),
    setPlaybackActive: vi.fn((active: boolean) => activeCalls.push(active)),
    ...overrides,
  };

  return { deps, activeCalls, playedPaths, stops, playDeferreds };
}

describe("createPlaybackQueue", () => {
  it("plays sentences in enqueue order even when synthesis resolves out of order", async () => {
    const synthDeferreds: Record<string, ReturnType<typeof deferred<{ path: string }>>> = {};
    const { deps, playedPaths, playDeferreds } = makeDeps({
      synthesize: vi.fn((text: string) => {
        const d = deferred<{ path: string }>();
        synthDeferreds[text] = d;
        return d.promise;
      }),
    });
    const queue = createPlaybackQueue(deps);

    queue.enqueue("First.");
    queue.enqueue("Second.");

    // Second finishes synthesizing before First — must still wait its turn.
    synthDeferreds["Second."].resolve({ path: "second.wav" });
    await flush();
    expect(playedPaths).toEqual([]);

    synthDeferreds["First."].resolve({ path: "first.wav" });
    await flush();
    expect(playedPaths).toEqual(["first.wav"]);

    playDeferreds[0].resolve();
    await flush();
    expect(playedPaths).toEqual(["first.wav", "second.wav"]);
  });

  it("reports playback active once at start and once when the queue drains, not per sentence", async () => {
    const { deps, activeCalls, playDeferreds } = makeDeps();
    const queue = createPlaybackQueue(deps);

    queue.enqueue("First.");
    queue.enqueue("Second.");
    await flush();
    expect(activeCalls).toEqual([true]);

    playDeferreds[0].resolve();
    await flush();
    expect(activeCalls).toEqual([true]);

    playDeferreds[1].resolve();
    await flush();
    expect(activeCalls).toEqual([true, false]);
  });

  it("re-activates for a later turn after the queue has drained", async () => {
    const { deps, activeCalls, playDeferreds } = makeDeps();
    const queue = createPlaybackQueue(deps);

    queue.enqueue("First.");
    await flush();
    playDeferreds[0].resolve();
    await flush();
    expect(activeCalls).toEqual([true, false]);

    queue.enqueue("Later turn.");
    await flush();
    expect(activeCalls).toEqual([true, false, true]);
  });

  it("clear stops current playback immediately and drops the rest of the queue", async () => {
    const { deps, stops, playedPaths, activeCalls } = makeDeps();
    const queue = createPlaybackQueue(deps);

    queue.enqueue("First.");
    queue.enqueue("Second.");
    await flush();
    expect(playedPaths).toEqual(["First."]);

    queue.clear();
    expect(stops).toHaveBeenCalledWith("First.");
    expect(activeCalls.at(-1)).toBe(false);

    await flush();
    expect(playedPaths).toEqual(["First."]);
  });

  it("accepts new sentences after clear, starting a fresh generation", async () => {
    const { deps, playedPaths, playDeferreds } = makeDeps();
    const queue = createPlaybackQueue(deps);

    queue.enqueue("First.");
    await flush();
    queue.clear();

    queue.enqueue("New turn.");
    await flush();
    expect(playedPaths).toEqual(["First.", "New turn."]);

    playDeferreds[1].resolve();
    await flush();
  });

  it("skips a sentence whose synthesis fails and continues with the next", async () => {
    const onError = vi.fn();
    const { deps, playedPaths, playDeferreds } = makeDeps({
      synthesize: vi
        .fn()
        .mockRejectedValueOnce(new Error("synth failed"))
        .mockResolvedValueOnce({ path: "second.wav" }),
      onError,
    });
    const queue = createPlaybackQueue(deps);

    queue.enqueue("First.");
    queue.enqueue("Second.");
    await flush();

    expect(onError).toHaveBeenCalledWith(expect.any(Error), "First.");
    expect(playedPaths).toEqual(["second.wav"]);

    playDeferreds[0].resolve();
    await flush();
  });

  it("strips markdown before synthesizing each sentence", async () => {
    const { deps } = makeDeps();
    const queue = createPlaybackQueue(deps);

    queue.enqueue("This is **bold** and `code`.");
    await flush();

    expect(deps.synthesize).toHaveBeenCalledWith("This is bold and code.");
  });

  it("skips a sentence that strips down to nothing", async () => {
    const { deps, playedPaths } = makeDeps();
    const queue = createPlaybackQueue(deps);

    queue.enqueue("```js\nconst x = 1;\n```");
    await flush();

    expect(deps.synthesize).not.toHaveBeenCalled();
    expect(playedPaths).toEqual([]);
  });
});
