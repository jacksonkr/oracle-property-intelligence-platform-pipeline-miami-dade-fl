import { join } from "node:path";
import { SOURCES } from "./catalog.js";
import { ensureStateTable, lit, openStore, rows, stateTable } from "./store.js";

/**
 * Restore pipeline state from a published snapshot into a fresh working store,
 * so the next run can compute deltas without the machine that made the last one.
 *
 *   npm run restore -- <snapshot root: local directory or https://<gateway>/ipfs/<root cid>> [data-dir]
 *
 * Only state is restored (keys, hashes, run history). Source rows are re-read
 * from the publisher on the next run.
 */
const base = process.argv[2];
if (!base) throw new Error("Pass the snapshot root: a directory or a gateway URL ending in the root CID");
const con = await openStore(join(process.argv[3] ?? "data", "oracle.duckdb"));
const file = (name: string) => lit(`${base.replace(/[\/]+$/, "").replaceAll("\\", "/")}/state/${name}.parquet`);

const [existing] = await rows(con, `SELECT count(*) AS n FROM pipeline_run`);
if (Number(existing?.n) > 0) throw new Error("This store already has run history; restore only into an empty store");

for (const table of ["pipeline_run", "pipeline_run_source", "pipeline_change"]) {
  await con.run(`INSERT INTO ${table} SELECT * FROM read_parquet(${file(table)})`);
}
for (const source of SOURCES) {
  await ensureStateTable(con, source.key);
  await con.run(`INSERT INTO ${stateTable(source.key)} SELECT * FROM read_parquet(${file(`key_state_${source.key}`)})`);
  const [row] = await rows(con, `SELECT count(*) AS n FROM ${stateTable(source.key)}`);
  console.log(`${source.key}: ${row?.n} keys restored`);
}
const [runs] = await rows(con, `SELECT count(*) AS n FROM pipeline_run`);
console.log(`run history: ${runs?.n} runs restored`);
