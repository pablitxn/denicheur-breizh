const CRAWLER_STATE_LOCK = "denicheur:crawler:state";

export async function withCrawlerStateLock<T>(operation: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks?.request) {
    throw new Error("This browser cannot safely coordinate local collection updates. Use a Chrome version with Web Locks support.");
  }
  return await locks.request(CRAWLER_STATE_LOCK, { mode: "exclusive" }, operation);
}
