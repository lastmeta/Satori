// The engine's download, as the person sees it go: src/db/opfs.js's onStep.
/**
 * DuckDB's download ({ bytesLoaded, bytesTotal }, its instantiate progress) in the bytes that cross the network
 * (docs/design/storage.md#the-first-visit): it counts the decoded wasm against the Content-Length, which is the
 * compressed size when the host compresses it (gzip, brotli), so the count is scaled by `raw` (the decoded size).
 * → { loaded, total } (total null: unknown)
 */
export function transferProgress({ bytesLoaded = 0, bytesTotal = 0 } = {}, raw = null) {
  if (!(bytesTotal > 0)) return { loaded: bytesLoaded, total: raw };
  const loaded = raw > bytesTotal ? Math.round((bytesLoaded * bytesTotal) / raw) : bytesLoaded;
  return { loaded: Math.min(loaded, bytesTotal), total: bytesTotal };
}
