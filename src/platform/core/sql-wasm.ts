/**
 * @file src/platform/core/sql-wasm.ts
 * @summary Shared sql.js WASM runtime loader for SQLite in-memory databases.
 * Uses the bundled sql.js package and embedded WASM binary (no CDN fetch).
 *
 * @exports
 *  - getSqlJs  — Lazy-load sql.js WASM, cached for reuse across the plugin
 *  - Database  — sql.js Database type
 *  - SqlJsStatic — sql.js static interface
 *  - SqlValue — sql.js SQL value type
 */

import initSqlJs from "sql.js/dist/sql-wasm-browser.js";
import type { Database, SqlJsStatic, SqlValue } from "sql.js";
import wasmDeflated from "sql.js/dist/sql-wasm.wasm";
import { unzlibSync } from "fflate/browser";

let _sqlJs: SqlJsStatic | null = null;
let _sqlJsPromise: Promise<SqlJsStatic> | null = null;
const initSqlJsTyped = initSqlJs as unknown as (config: {
  wasmBinary: ArrayBuffer;
}) => Promise<SqlJsStatic>;

/**
 * Lazily initialise sql.js. Uses the bundled sql.js package and embedded WASM
 * binary (no CDN fetch). Subsequent calls return the cached instance.
 *
 * The WASM is inlined into main.js as a deflated zlib stream rather than raw
 * base64 (see deflateWasmPlugin in tooling/esbuild.config.js) because the raw
 * base64 cost ~880 KB of the bundle, and main.js has to stay under Obsidian
 * Sync's 5 MB per-file limit. Inflating the 660 KB binary takes a few ms.
 */
export async function getSqlJs(): Promise<SqlJsStatic> {
  if (_sqlJs) return _sqlJs;
  if (_sqlJsPromise) return _sqlJsPromise;

  _sqlJsPromise = (async () => {
    const deflated =
      wasmDeflated instanceof Uint8Array ? wasmDeflated : new Uint8Array(wasmDeflated);
    const wasmArray = unzlibSync(deflated);
    const wasmBuffer = wasmArray.slice().buffer;

    _sqlJs = await initSqlJsTyped({ wasmBinary: wasmBuffer });
    return _sqlJs;
  })().catch((err) => {
    // Reset so the next call retries instead of returning a stale rejected promise
    _sqlJsPromise = null;
    throw err;
  });

  return _sqlJsPromise;
}

export type { Database, SqlJsStatic, SqlValue };
