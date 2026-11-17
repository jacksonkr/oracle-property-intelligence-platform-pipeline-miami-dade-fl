# Decisions

Short record of the choices that shape this pipeline, newest last.

## 1. Read the county's public ArcGIS layers, paged by ObjectID range

Each page is an independent request (`OBJECTID >= a AND OBJECTID < b`). Pages run in
parallel, can be retried alone, and the request URL is stored on every row as its
provenance. Result offsets were rejected: a page's content would depend on the pages
before it.

## 2. Change detection by content hash, per record key

The source layers carry no per-row change timestamp. Each row is hashed over its source
attributes (ObjectID excluded, since the publisher may renumber it). A run compares hashes
against the previous snapshot and records added, changed and removed keys.

A partial run (bounded pilot) only upserts. It never reports removals, because a record
missing from a partial capture proves nothing.

## 3. DuckDB as a local working store; nothing hosted

The store is one file. It holds the latest snapshot per source and the run history.
Published artifacts will be Parquet on IPFS, so no database server is needed to query them.

## 4. Record keys

| Source | Key | Why |
|---|---|---|
| properties | `FOLIO` | The county's parcel identifier, kept as text. 5,830 source rows have none and are excluded and counted. |
| permits | `PermitNumber` | Unique across all 489,896 rows. |
| contractors | `CONTRACTOR_NUMBER`, `TRADESMEN_NAME`, `TRADE_CLASS` | The table has one row per contractor, tradesman and trade class. The licence number alone collapsed 278 rows; this key collapses 2. |

## 5. Follow the assignment README where it differs from the team kit

The kit's Oracle skills publish only lexicon archives registered in Atlas, which needs a
Prism code-owner merge. The README asks for a manifest of query tables, coverage and
indexes retrievable by CID from public gateways. This pipeline implements the README.
Lexicon-format output is a possible later addition, not the publication path.

## 6. Source access rules are hard limits

Sources are read only through public, documented endpoints, within robots.txt. A 403 or a
challenge page stops that source and is recorded as a limitation. No block is evaded.
