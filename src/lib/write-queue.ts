// Serializes async operations that share a key, so a later call on the same
// key always starts after the earlier one has fully settled (success or
// failure). Used to prevent read-modify-write races when a store reads its
// current in-memory state, awaits a file write, then applies the result —
// two concurrent calls on the same file would otherwise interleave and one
// write could silently clobber the other's change (spec M8).

const queues = new Map<string, Promise<unknown>>();

export function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = queues.get(key) ?? Promise.resolve();
  const result = prior.then(fn, fn);
  queues.set(
    key,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}
