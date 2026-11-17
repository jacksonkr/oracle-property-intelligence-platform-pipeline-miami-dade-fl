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

## 7. Permit status is derived, and named for what the dates support

The county table has no status column. `status` is one of `closed_certificate`,
`last_inspection_approved`, `last_inspection_not_approved`, `no_inspection`. A permit is
treated as open in the last two cases. "Last inspection approved" is not proof of a final
inspection, so the UI and agent show the derived label, not the word "closed".

## 8. Roof year: a completed roof permit beats year built; otherwise unknown

`roof_basis` records which was used. A roof permit counts only when it is a re-roof or a
new-construction roof and its status is approved or certified; an open permit never sets
the roof year. Year built of 0 or a placeholder such as 9999 is treated as not recorded.
Because county permits start in 2020, most roof years rest on year built: that is a proxy
and is labelled as one.

## 9. No column depends on today's date

Roof age and days open are computed at query time from `roof_year` and `issued_date`.
Identical source data therefore produces byte-identical tables, and a new published CID
always means the data changed.

## 10. Reconciliation is by official identifier or exact match only

Properties by folio, permits by permit number, contractors by the licence number printed
on the permit (name variants are counted, not merged), owners by exact name plus mailing
address. Near-matches such as "USA" and "U S A" stay separate: merging them would be a guess.

## 11. Content IDs are computed locally, before any upload

`npm run snapshot` builds the IPFS directory DAG itself (CIDv1, raw leaves, the same
settings as `ipfs add --cid-version=1`) and writes it to one CAR file. The upload is then
a block transfer that any node can check. Verified against a reference Kubo 0.43.1 node
running offline: it imported the CAR, pinned the same root, and independently computed the
same CID for every file, the directory, the CAR and the manifest.

A table that did not change keeps its CID from one snapshot to the next; only `coverage.json`
(which carries the snapshot time) and the directory root differ. This required replacing
`any_value()` in the model with `min()`: the arbitrary pick made two builds of identical
data produce different Parquet files.

## 12. The manifest is published beside the snapshot, not inside it

The manifest names the root directory's CID, so it cannot live under that root. It is its
own file with its own CID, recorded in `publications/` in Git along with the previous
snapshot's manifest and root CIDs.

## 13. Pipeline state is published, so a run needs no machine of ours

Deltas are computed against `key_state_<source>` (record key and content hash), not the
previous full rows. Each snapshot carries those tables plus the change log and run history
under `state/`. `npm run restore` loads them into an empty store, and the next run reports
the same deltas it would have on the original machine. This is what lets a scheduled job on
a fresh runner be incremental with no hosted database.

## 14. Every listed CID is pinned as its own root

A pinning node announces the root of each upload, not the blocks inside it. A file reachable
only by path under the snapshot directory may not be found by its own CID on the public
network. So each file, the CAR file and the manifest are also uploaded as single-root CARs,
keyed by CID (an unchanged artifact is never uploaded twice).

## 15. Which gateways count as independent retrieval

The README's example gateways, `ipfs.io` and `dweb.link`, now answer plain HTTP requests
with 429 and a notice that they serve only through an in-browser service worker, so they
cannot be used for a scripted byte check. Retrieval is verified against a configurable list
of other public gateways not operated by us or by the pinning vendor (`src/gateways.ts`).
The pinning vendor's own gateway is recorded but never counts toward the required two.
Every attempt, including failures, is saved in `publications/<snapshot>/retrieval.json`.

A snapshot is added to `publications/index.json` only when every listed CID was fetched
from two independent gateways with matching size and SHA-256.

## 16. `fetched_at` is when this version of a record was captured

A record that did not change keeps the capture time of the run that first saw its current
content. Stamping every row with the latest run's time made a re-read of identical data
produce different files and a new CID for every table. When each source was last re-read
is in the run history, not on the rows. Verified with two full back-to-back ingests: every
data table kept its CID; only the run history and coverage files changed.

## 17. One tool catalogue for the page's agent and the MCP endpoint

`web/lib/tools.ts` defines each capability once: name, description, Zod input schema and a
`run` function that calls the shared query layer. The agent (Vercel AI SDK) and `/api/mcp`
(Streamable HTTP) both register that same list, so they cannot give different answers.

The model decides which tools to call and words the reply. Every count and record comes from
SQL over the snapshot, and the tool calls (input, SQL, snapshot ID, rows) are returned beside
the answer so it can be checked against the records.

## 18. Outside SQL is guarded twice

`query_sql` lets an agent or MCP client run its own query. Two independent guards:
DuckDB's parser must report exactly one statement of type SELECT, and the engine is locked
before any request reaches it (`allowed_directories` = the snapshot folder,
`enable_external_access = false`, `lock_configuration = true`). Tested: reading other
files, fetching URLs, loading extensions, attaching databases and changing settings are all
refused. A write into the snapshot folder would pass the engine lock, which is why the
statement-type check is not optional.

## 19. Agent model: the one that answers on the free tier

Measured against the Gemini API with a free key: the newest flash models timed out or
returned "high demand" errors, `gemini-3.5-flash` took 8 to 16 seconds per call and
`gemini-3.5-flash-lite` about one second. The agent tries flash-lite, then flash, each with
a 50-second limit and no silent retries, and returns a plain error if both fail. The model
list is an environment variable (`AGENT_MODELS`).

## 20. Property results are one row per street address

A condo building is one roof. Listing each unit put 88 rows for one address at the top of an
"oldest roofs" search. Results now return one row per address with the number of matching
units; the total still counts properties.

## 21. A run that finds no change publishes nothing

Identical data must not get a new CID, and each published snapshot costs about 320 MB of a
5 GB free quota. After the sources are re-read, `npm run record-check` sums the added,
changed and removed records since the latest published snapshot. If the sum is zero, the
check is appended to `publications/checks.json` and no snapshot is built. Only a real change
produces a new snapshot. The page shows both: publications and no-change checks.

The one exception so far is the third snapshot. It carries no source change; it was
published because the pipeline's own state format changed (decision 16 added a capture time
to the key state), and scheduled runs need to restore from a snapshot that has it.

## 22. The runtime is one Lambda function, defined in CDK

`infra/` holds a single CDK stack: a Lambda function built from `web/Dockerfile` (2 GB,
x86_64, 120-second timeout, 1 GB of scratch space), a public function URL, a log group kept
for one week, and an IAM policy with one statement, `ssm:GetParameter` on one parameter.
There is no API Gateway, VPC, database or queue, so nothing runs or bills while idle.

- **Container image with the Lambda Web Adapter.** The Next.js server runs unchanged; the
  adapter translates Lambda invocations to HTTP. The image is built on Linux, so DuckDB's
  Linux binary and shared library are the ones packaged.
- **Standard Lambda, not Lambda Web Functions.** The newer service is arm64-only and allows
  10 seconds to start; a cold start here downloads about 110 MB of tables from IPFS.
- **The model key is an encrypted SSM parameter**, read once per warm instance. It is not in
  the function's environment, the template or the repository.
- **The framework's disk cache is replaced by a five-minute in-memory cache**, because
  Lambda's filesystem is read-only outside `/tmp`.
- **Public by design.** The assignment needs a runtime anyone can open. The data is public
  record, inputs are validated, and outside SQL is limited as in decision 18.

Tested before deploying by running the image locally with a read-only filesystem and a
non-root user, then on the deployed function: page, API, MCP, live verification and agent.

## 23. State licences come from DBPR's published file, joined by exact licence number

Florida DBPR publishes its construction licensee file as public record with a documented
column layout. It is a second kind of source (`kind: "csv"`): one request for the whole
file, rows hashed and compared like any other source. If a row does not have the documented
number of columns the run stops, because shifted columns would corrupt every field.

- **Join:** the licence number printed on a permit equals DBPR's "Alternate Lic#". Only an
  exact match counts. 1,917 of 2,237 roofing contractors match, covering 74,124 of 85,385
  roofing permits.
- **What a miss means:** the file omits null and void, delinquent and involuntarily inactive
  licences. "Not in the state licence file" is shown as exactly that, not as "unlicensed".
- **Business records:** about half the file is qualified-business registrations with a name
  and address but no licence number. They are published as the `business` table. A contractor
  whose name equals a qualified business's name is flagged as a name match only.
- **Key:** licences have a number; qualified businesses do not, so name, address and original
  date are part of the key. The first attempt keyed on the number alone and collapsed 128,990
  business rows into one.
