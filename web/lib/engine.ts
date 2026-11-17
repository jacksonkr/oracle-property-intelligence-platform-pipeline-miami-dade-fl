import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { getLatest, READ_GATEWAYS, type Artifact, type Manifest, type Publication } from "./snapshot";

/**
 * The query engine: DuckDB over the published Parquet files.
 *
 * There is no database server. On first use the tables are fetched from IPFS by
 * CID, checked against the manifest's size and SHA-256, and kept in the
 * function's temp directory. DuckDB then reads them in place.
 */

const TABLES = ["property", "permit", "contractor", "place"] as const;

export interface Engine {
  con: DuckDBConnection;
  publication: Publication;
  manifest: Manifest;
  loadedInMs: number;
}

async function download(artifact: Artifact, target: string): Promise<void> {
  if (existsSync(target) && statSync(target).size === artifact.size) return;
  let lastError: unknown;
  for (const gateway of READ_GATEWAYS) {
    try {
      const response = await fetch(`${gateway}/${artifact.cid}`, { cache: "no-store" });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const hash = createHash("sha256");
      const part = `${target}.${process.pid}.part`;
      await pipeline(
        Readable.fromWeb(response.body as never),
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            hash.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(part),
      );
      // Content addressing only helps if it is checked: refuse bytes that differ.
      if (hash.digest("hex") !== artifact.sha256) throw new Error("SHA-256 does not match the manifest");
      renameSync(part, target);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Could not fetch ${artifact.name} (${artifact.cid}): ${String(lastError)}`);
}

async function load(): Promise<Engine> {
  const started = Date.now();
  const { publication, manifest } = await getLatest();
  const dir = join(tmpdir(), `oracle-${manifest.root.cid}`);
  mkdirSync(dir, { recursive: true });

  await Promise.all(
    TABLES.map(async (table) => {
      const artifact = manifest.artifacts.find((a) => a.name === `tables/${table}.parquet`);
      if (!artifact) throw new Error(`The manifest has no tables/${table}.parquet`);
      await download(artifact, join(dir, `${table}.parquet`));
    }),
  );
  const con = await (await DuckDBInstance.create(":memory:")).connect();
  for (const table of TABLES) {
    const file = join(dir, `${table}.parquet`).replaceAll("\\", "/").replaceAll("'", "''");
    await con.run(`CREATE VIEW ${table} AS SELECT * FROM read_parquet('${file}')`);
  }
  return { con, publication, manifest, loadedInMs: Date.now() - started };
}

let engine: Promise<Engine> | null = null;
let checkedAt = 0;

/** One engine per warm function instance; reloaded when a newer snapshot is published. */
export async function getEngine(): Promise<Engine> {
  if (engine && Date.now() - checkedAt > 5 * 60_000) {
    checkedAt = Date.now();
    const current = await engine.catch(() => null);
    const latest = await getLatest().catch(() => null);
    if (current && latest && latest.publication.root_cid !== current.publication.root_cid) engine = null;
  }
  if (!engine) {
    checkedAt = Date.now();
    engine = load().catch((error) => {
      engine = null;
      throw error;
    });
  }
  return engine;
}

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  sql: string;
  ms: number;
  snapshot: { id: string; root_cid: string; manifest_cid: string };
}

/** Run one read-only statement with named parameters and report what ran. */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params: Record<string, string | number | boolean | null> = {},
): Promise<QueryResult<T>> {
  const { con, publication } = await getEngine();
  const started = Date.now();
  const reader = await con.runAndReadAll(sql, params as never);
  return {
    rows: reader.getRowObjectsJson() as T[],
    sql: sql.replace(/\s+/g, " ").trim(),
    ms: Date.now() - started,
    snapshot: { id: publication.snapshot_id, root_cid: publication.root_cid, manifest_cid: publication.manifest_cid },
  };
}
