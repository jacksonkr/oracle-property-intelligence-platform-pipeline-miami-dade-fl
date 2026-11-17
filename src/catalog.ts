import { z } from "zod";

/**
 * Source catalog: the single place that says where Miami-Dade data comes from.
 * Every ingested row carries its source key and the exact request that returns it,
 * so each answer downstream can be traced back to a public record.
 */
export const sourceSchema = z.object({
  /** Stable identifier; also the DuckDB table suffix (`src_<key>`). */
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  /** What one row represents. */
  entity: z.string().min(1),
  publisher: z.string().min(1),
  /** ArcGIS FeatureServer layer URL (no trailing slash, no `/query`). */
  layerUrl: z.string().url(),
  /** Field that identifies the real-world record across runs. */
  keyField: z.string().min(1),
  /** True when the layer has point geometry to capture as WGS84 lon/lat. */
  hasGeometry: z.boolean(),
  /** Known limits of this source, shown in run history. */
  limitations: z.array(z.string()),
});

export type Source = z.infer<typeof sourceSchema>;

const MDC = "https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services";

export const COUNTY = {
  name: "Miami-Dade",
  state: "FL",
  fips: "12086",
  slug: "miami-dade",
} as const;

export const SOURCES: Source[] = z.array(sourceSchema).parse([
  {
    key: "properties",
    entity: "property (one row per folio: site address, owner, mailing address, year built, last sale, coordinates)",
    publisher: "Miami-Dade County Property Appraiser (PaGISView)",
    layerUrl: `${MDC}/PaGISView_gdb/FeatureServer/0`,
    keyField: "FOLIO",
    hasGeometry: true,
    limitations: [
      "Carries only the most recent sale (DOS_1 / PRICE_1), not full sale history.",
      "The layer has no per-row change timestamp, so change detection is a full-snapshot hash comparison.",
    ],
  },
  {
    key: "permits",
    entity: "building permit (one row per permit number: type, dates, folio, contractor, last inspection)",
    publisher: "Miami-Dade County Building Department (miamidade_permit_data)",
    layerUrl: `${MDC}/miamidade_permit_data/FeatureServer/0`,
    keyField: "PermitNumber",
    hasGeometry: false,
    limitations: [
      "Covers permits issued by the county building department from 2020-01-01; municipal building departments keep their own systems.",
      "The table has no status column: open or closed is derived from inspection and certificate dates.",
    ],
  },
  {
    key: "contractors",
    entity: "contractor licence record held by the county (name, licence number, status, trade categories)",
    publisher: "Miami-Dade County Building Department (Contractor)",
    layerUrl: `${MDC}/Contractor/FeatureServer/0`,
    keyField: "CONTRACTOR_NUMBER",
    hasGeometry: false,
    limitations: ["County-held licence records only; state licence standing comes from DBPR."],
  },
]);

export function getSource(key: string): Source {
  const source = SOURCES.find((s) => s.key === key);
  if (!source) {
    throw new Error(`Unknown source "${key}". Known: ${SOURCES.map((s) => s.key).join(", ")}`);
  }
  return source;
}
