import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fetchRange, getLayerInfo, getOidBounds, mapConcurrent, planRanges } from "./arcgis.js";
import { COUNTY, getSource } from "./catalog.js";
import { lit, loadSource, openStore } from "./store.js";

/**
 * One pipeline run for one source: capture -> load -> record deltas.
 *
 *   npm run ingest -- --source properties            full refresh
 *   npm run ingest -- --source properties --max-pages 5   bounded pilot (partial)
 */

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    "max-pages": { type: "string" },
    concurrency: { type: "string", default: "4" },
    "data-dir": { type: "string", default: "data" },
  },
});
if (!values.source) throw new Error("--source is required");

const source = getSource(values.source);
const dataDir = values["data-dir"];
const concurrency = Number(values.concurrency);
const maxPages = values["max-pages"] ? Number(values["max-pages"]) : null;

const startedAt = new Date();
const runId = startedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const rawDir = join(dataDir, "raw", runId, source.key);
mkdirSync(rawDir, { recursive: true });

const con = await openStore(join(dataDir, "oracle.duckdb"));
await con.run(`INSERT INTO pipeline_run VALUES
  (${lit(runId)}, ${lit(COUNTY.slug)}, ${lit(startedAt.toISOString())}, NULL, 'RUNNING')`);

try {
  const info = await getLayerInfo(source.layerUrl);
  const bounds = await getOidBounds(source.layerUrl, info.oidField);
  const allRanges = planRanges(bounds.min, bounds.max, info.maxRecordCount);
  const ranges = maxPages ? allRanges.slice(0, maxPages) : allRanges;
  const partial = ranges.length < allRanges.length;
  console.log(
    `[${runId}] ${source.key}: ${bounds.count} rows reported, ${ranges.length}/${allRanges.length} pages` +
      (partial ? " (partial run)" : ""),
  );

  let done = 0;
  await mapConcurrent(ranges, concurrency, async (range, index) => {
    const captured = await fetchRange(source.layerUrl, info.oidField, range, source.hasGeometry);
    const file = join(rawDir, `part-${String(index).padStart(6, "0")}.ndjson`);
    writeFileSync(file, captured.map((row) => JSON.stringify(row)).join("\n") + "\n");
    if (++done % 50 === 0 || done === ranges.length) console.log(`  ${done}/${ranges.length} pages`);
  });

  const glob = join(rawDir, "*.ndjson").replaceAll("\\", "/");
  const result = await loadSource(con, source, info.fields, info.oidField, glob, runId, partial);
  const seconds = (Date.now() - startedAt.getTime()) / 1000;

  await con.run(`INSERT INTO pipeline_run_source VALUES (
    ${lit(runId)}, ${lit(source.key)}, ${lit(source.layerUrl)}, ${lit(info.dataLastEditAt)},
    ${bounds.count}, ${result.fetchedRows}, ${result.distinctKeys}, ${result.duplicateRows},
    ${result.rowsWithoutKey}, ${result.added}, ${result.changed}, ${result.removed ?? "NULL"},
    ${result.unchanged}, ${ranges.length}, ${seconds}, ${partial}, ${lit(source.limitations.join(" | "))})`);
  await con.run(`UPDATE pipeline_run SET status = ${lit(partial ? "PARTIAL" : "COMPLETE")},
    finished_at = ${lit(new Date().toISOString())} WHERE run_id = ${lit(runId)}`);
  console.log(JSON.stringify({ runId, source: source.key, partial, seconds, ...result }, null, 2));
} catch (error) {
  await con.run(`UPDATE pipeline_run SET status = 'FAILED',
    finished_at = ${lit(new Date().toISOString())} WHERE run_id = ${lit(runId)}`);
  throw error;
}
