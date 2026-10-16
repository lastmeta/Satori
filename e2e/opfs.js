// OPFS from the page's main thread, for the specs: the files DuckDB keeps, read even while it holds them.

/** [name, bytes] of each file at OPFS's root, by name. */
export const opfsFiles = (page) => page.evaluate(async () => {
  const out = [];
  for await (const [name, h] of (await navigator.storage.getDirectory()).entries()) {
    if (h.kind === 'file') out.push([name, (await h.getFile()).size]);
  }
  return out.sort(([a], [b]) => (a < b ? -1 : 1));
});

/** Copy one OPFS file to another name (the copy alone, without its WAL). */
export const opfsCopy = (page, from, to) => page.evaluate(async ([from, to]) => {
  const dir = await navigator.storage.getDirectory();
  const data = await (await (await dir.getFileHandle(from)).getFile()).arrayBuffer();
  const w = await (await dir.getFileHandle(to, { create: true })).createWritable();
  await w.write(data);
  await w.close();
}, [from, to]);
