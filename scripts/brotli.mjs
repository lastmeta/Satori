// Brotli copies of a build's DuckDB wasm (dist/assets/duckdb-eh-*.wasm → .br), which deploy/nginx.conf serves where the
// browser takes brotli: 5.1 MB on the wire, not gzip's 7.7 (docs/design/deploy.md#compression). The image's nginx has
// no brotli module, so the copies are made here. Quality 11 takes minutes, so each is kept by its content's hash
// (node_modules/.cache/satori-brotli) and made once per DuckDB version.
//   node scripts/brotli.mjs [dist/assets]
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { brotliCompressSync, constants } from 'node:zlib';

const dir = process.argv[2] ?? 'dist/assets';
const cache = 'node_modules/.cache/satori-brotli';
mkdirSync(cache, { recursive: true });
const files = readdirSync(dir).filter((n) => /^duckdb-eh.*\.wasm$/.test(n));
if (!files.length) throw new Error(`${dir}: no duckdb-eh wasm`);
for (const f of files) {
  const raw = readFileSync(`${dir}/${f}`);
  const kept = `${cache}/${createHash('sha256').update(raw).digest('hex')}.br`;
  if (!existsSync(kept)) {
    const t0 = Date.now();
    writeFileSync(kept, brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_LGWIN]: 24, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }));
    console.log(`brotli: ${f} compressed in ${Math.round((Date.now() - t0) / 1000)} s`);
  }
  copyFileSync(kept, `${dir}/${f}.br`);
  console.log(`brotli: ${dir}/${f}.br ${(statSync(kept).size / 1e6).toFixed(2)} MB (${(raw.length / 1e6).toFixed(2)} MB raw)`);
}
