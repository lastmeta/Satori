import { expect, test } from 'vitest';
import { transferProgress } from './progress.js';

test('transferProgress: DuckDB\'s download in the bytes that cross the network (docs/design/storage.md#the-first-visit)', () => {
  const RAW = 34_242_586; // duckdb-eh.wasm, decoded
  // gzip (7.6 MB on the wire): DuckDB counts decoded bytes against the Content-Length, so the count is scaled
  expect(transferProgress({ bytesLoaded: RAW / 2, bytesTotal: 7_677_553 }, RAW)).toEqual({ loaded: 3_838_777, total: 7_677_553 });
  expect(transferProgress({ bytesLoaded: RAW, bytesTotal: 5_065_391 }, RAW)).toEqual({ loaded: 5_065_391, total: 5_065_391 }); // brotli, done
  // not compressed (the dev server): as counted
  expect(transferProgress({ bytesLoaded: 1_000_000, bytesTotal: RAW }, RAW)).toEqual({ loaded: 1_000_000, total: RAW });
  // no Content-Length: the decoded count against the decoded size
  expect(transferProgress({ bytesLoaded: 1_000_000, bytesTotal: 0 }, RAW)).toEqual({ loaded: 1_000_000, total: RAW });
  expect(transferProgress({ bytesLoaded: 5, bytesTotal: 0 })).toEqual({ loaded: 5, total: null });
  expect(transferProgress({ bytesLoaded: 50, bytesTotal: 10 })).toEqual({ loaded: 10, total: 10 }); // never past the total
});
