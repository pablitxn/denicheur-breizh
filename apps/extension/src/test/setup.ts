import { beforeEach } from "vitest";

// jsdom has no Web Locks. Serialize exclusive locks for deterministic unit
// tests; browser E2E verifies exclusion across real extension contexts.
beforeEach(() => {
  const queued = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T> {
        if (options.ifAvailable && queued.has(name)) return Promise.resolve(callback(null));
        const predecessor = queued.get(name) ?? Promise.resolve();
        const result = predecessor.catch(() => undefined).then(() => {
          if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
          return callback({ name, mode: options.mode ?? "exclusive" } as Lock);
        });
        queued.set(name, result);
        void result.finally(() => {
          if (queued.get(name) === result) queued.delete(name);
        }).catch(() => undefined);
        return result;
      },
    },
  });
});
