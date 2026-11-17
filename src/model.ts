import type { DuckDBConnection } from "@duckdb/node-api";

/**
 * The query model: four tables derived from the source snapshots.
 *
 *   property    one row per folio, with the roof-age basis and owner location
 *   permit      one row per permit, with a derived status and a roofing flag
 *   contractor  one row per contractor number seen on permits
 *   owner       one row per distinct owner name + mailing address
 *   place       one row per site city, with the centre of its properties
 *
 * Rules that matter:
 * - Nothing here depends on today's date. Ages and open durations are computed
 *   at query time, so identical source data always produces identical tables.
 * - Every row keeps the source request it came from (`source_url`).
 * - Derived values say what they are derived from (`roof_basis`, `status`).
 * - Aggregates must be deterministic: use min/max, never any_value, or two
 *   builds of the same data produce different files and different CIDs.
 */

const ms = (column: string) => `make_timestamp(${column} * 1000)::DATE`;
const text = (column: string) => `nullif(trim(${column}), '')`;
const zip5 = (column: string) => `nullif(regexp_extract(${column}, '^[0-9]{5}'), '')`;

/** A roof covering category, excluding equipment mounted on a roof. */
const ROOF_CATEGORY = `(CategoryDescription1 ILIKE '%ROOF%' AND CategoryDescription1 NOT ILIKE '%ROOF MOUNTED%')`;

const PERMIT = `
CREATE OR REPLACE TABLE permit AS
SELECT
  PermitNumber                          AS permit_number,
  ${text("ProcessNumber")}              AS process_number,
  ${text("FolioNumber")}                AS folio,
  PermitType                            AS permit_type,
  ApplicationTypeDescription            AS application_type,
  ResidentialCommercial                 AS residential_commercial,
  ${text("DetailDescriptionComments")}  AS description,
  ${text("CategoryDescription1")}       AS category,
  ${text("PropertyAddress")}            AS address,
  try_cast(PermitIssuedDate AS DATE)    AS issued_date,
  ${ms("ApplicationDate")}              AS application_date,
  ${ms("LastInspectionDate")}           AS last_inspection_date,
  ${ms("LastApprovedInspDate")}         AS last_approved_inspection_date,
  try_strptime(${text("CoCcDate")}, '%m/%d/%Y')::DATE AS certificate_date,
  try_cast(EstimatedValue AS DOUBLE)    AS estimated_value,
  ${text("ContractorNumber")}           AS contractor_number,
  ${text("ContractorName")}             AS contractor_name,
  CASE
    WHEN ApplicationTypeDescription = 'RE-ROOF/REPAIR' THEN 'reroof'
    WHEN ApplicationTypeDescription = 'ROOF MAINTENANCE' THEN 'roof_maintenance'
    WHEN ApplicationTypeDescription = 'NEW' AND ${ROOF_CATEGORY} THEN 'new_construction_roof'
    WHEN ${ROOF_CATEGORY} THEN 'other_roof_work'
  END                                   AS roofing_kind,
  -- The county publishes no status column. This is what its dates support, no more.
  CASE
    WHEN ${text("CoCcDate")} IS NOT NULL THEN 'closed_certificate'
    WHEN LastInspectionDate IS NULL THEN 'no_inspection'
    WHEN LastApprovedInspDate IS NOT NULL AND LastApprovedInspDate >= LastInspectionDate
      THEN 'last_inspection_approved'
    ELSE 'last_inspection_not_approved'
  END                                   AS status,
  _source_url                           AS source_url,
  _fetched_at                           AS fetched_at
FROM src_permits;

ALTER TABLE permit ADD COLUMN is_roofing BOOLEAN;
ALTER TABLE permit ADD COLUMN is_open BOOLEAN;
UPDATE permit SET
  is_roofing = roofing_kind IS NOT NULL,
  is_open = status IN ('no_inspection', 'last_inspection_not_approved');
`;

const PROPERTY = `
CREATE OR REPLACE TEMP TABLE county_zip AS
SELECT DISTINCT ${zip5("TRUE_SITE_ZIP_CODE")} AS zip FROM src_properties
WHERE ${zip5("TRUE_SITE_ZIP_CODE")} IS NOT NULL;

-- The roof date a permit supports: the latest re-roof or new-construction roof
-- permit whose last inspection was approved or that has a certificate.
CREATE OR REPLACE TEMP TABLE roof_permit AS
SELECT folio, permit_number, contractor_number, contractor_name,
       coalesce(certificate_date, last_approved_inspection_date) AS roof_date
FROM permit
WHERE roofing_kind IN ('reroof', 'new_construction_roof')
  AND status IN ('closed_certificate', 'last_inspection_approved')
  AND folio IS NOT NULL
QUALIFY row_number() OVER (
  PARTITION BY folio
  ORDER BY coalesce(certificate_date, last_approved_inspection_date) DESC, permit_number DESC) = 1;

CREATE OR REPLACE TABLE property AS
WITH base AS (
  SELECT
    FOLIO                                 AS folio,
    ${text("TRUE_SITE_ADDR_NO_UNIT")}     AS site_address,
    ${text("TRUE_SITE_UNIT")}             AS site_unit,
    ${text("TRUE_SITE_CITY")}             AS site_city,
    ${zip5("TRUE_SITE_ZIP_CODE")}         AS site_zip,
    ${text("TRUE_OWNER1")}                AS owner_1,
    ${text("TRUE_OWNER2")}                AS owner_2,
    ${text("TRUE_MAILING_ADDR1")}         AS mailing_address,
    ${text("TRUE_MAILING_CITY")}          AS mailing_city,
    ${text("TRUE_MAILING_STATE")}         AS mailing_state,
    ${zip5("TRUE_MAILING_ZIP_CODE")}      AS mailing_zip,
    ${text("TRUE_MAILING_COUNTRY")}       AS mailing_country,
    ${text("DOR_DESC")}                   AS land_use,
    CONDO_FLAG = 'Y'                      AS is_condo,
    -- 0 and placeholder years (for example 9999) mean "not recorded".
    CASE WHEN YEAR_BUILT BETWEEN 1800 AND year(_fetched_at) + 1 THEN YEAR_BUILT END::INTEGER AS year_built,
    nullif(BUILDING_HEATED_AREA, 0)       AS building_area,
    nullif(LOT_SIZE, 0)                   AS lot_size,
    ASSESSED_VAL_CUR                      AS assessed_value,
    ${ms("DATEOFSALE_UTC")}               AS last_sale_date,
    nullif(PRICE_1, 0)                    AS last_sale_price,
    _lon AS lon, _lat AS lat,
    _source_url AS source_url, _fetched_at AS fetched_at
  FROM src_properties
)
SELECT
  b.*,
  -- Roof year: a completed roof permit beats year built; otherwise unknown.
  coalesce(year(r.roof_date), b.year_built)::INTEGER AS roof_year,
  CASE WHEN r.roof_date IS NOT NULL THEN 'roof_permit'
       WHEN b.year_built IS NOT NULL THEN 'year_built'
       ELSE 'unknown' END                 AS roof_basis,
  r.roof_date                             AS roof_permit_date,
  r.permit_number                         AS roof_permit_number,
  r.contractor_number                     AS roof_contractor_number,
  CASE
    WHEN b.mailing_address IS NULL THEN 'unknown'
    WHEN b.mailing_country IS NOT NULL AND upper(b.mailing_country) NOT IN ('USA', 'US', 'UNITED STATES') THEN 'foreign'
    WHEN b.mailing_state IS NOT NULL AND b.mailing_state <> 'FL' THEN 'out_of_state'
    WHEN z.zip IS NULL THEN 'florida_outside_county'
    WHEN b.mailing_zip = b.site_zip AND b.mailing_address = b.site_address THEN 'at_property'
    ELSE 'in_county'
  END                                     AS owner_location,
  md5(upper(coalesce(b.owner_1, '')) || '|' || upper(coalesce(b.mailing_address, '')) || '|' || coalesce(b.mailing_zip, ''))
                                          AS owner_id
FROM base b
LEFT JOIN roof_permit r ON r.folio = b.folio
LEFT JOIN county_zip z ON z.zip = b.mailing_zip;

-- A permit takes its location from the property it is filed against.
ALTER TABLE permit ADD COLUMN property_matched BOOLEAN;
ALTER TABLE permit ADD COLUMN lon DOUBLE;
ALTER TABLE permit ADD COLUMN lat DOUBLE;
UPDATE permit SET property_matched = false;
UPDATE permit SET property_matched = true, lon = p.lon, lat = p.lat
FROM property p WHERE p.folio = permit.folio;
`;

const CONTRACTOR = `
-- One row per contractor number printed on permits. Name variants are counted,
-- not merged: the number is the identity, the most-used name is the label.
CREATE OR REPLACE TABLE contractor AS
WITH names AS (
  SELECT contractor_number, contractor_name, count(*) AS n
  FROM permit WHERE contractor_number IS NOT NULL GROUP BY ALL
),
county AS (
  SELECT CONTRACTOR_NUMBER AS contractor_number,
         min(CONTRACTOR_STATUS) AS county_status,
         min(_source_url) AS county_source_url
  FROM src_contractors GROUP BY 1
)
SELECT
  p.contractor_number,
  (SELECT contractor_name FROM names n WHERE n.contractor_number = p.contractor_number
   ORDER BY n DESC, contractor_name LIMIT 1) AS name,
  count(DISTINCT p.contractor_name)        AS name_variants,
  count(*)                                 AS permits,
  count(*) FILTER (p.is_roofing)           AS roofing_permits,
  count(*) FILTER (p.is_roofing AND p.is_open) AS open_roofing_permits,
  min(p.issued_date)                       AS first_permit_date,
  max(p.issued_date)                       AS last_permit_date,
  -- Florida state licence numbers start with a class prefix such as CCC (roofing) or CGC.
  nullif(regexp_extract(p.contractor_number, '^(C[A-Z]C)[A-Z]?[0-9]+$', 1), '') AS state_licence_class,
  c.county_status,
  c.county_source_url,
  min(p.source_url)                  AS source_url
FROM permit p LEFT JOIN county c USING (contractor_number)
WHERE p.contractor_number IS NOT NULL
GROUP BY p.contractor_number, c.county_status, c.county_source_url;
`;

const PLACE = `
-- Named places for "near <city>" questions: the centre of each site city's
-- properties. Derived from the roll itself, so no outside geocoder is needed.
CREATE OR REPLACE TABLE place AS
SELECT site_city AS name,
       count(*) AS properties,
       median(lat) AS lat,
       median(lon) AS lon
FROM property
WHERE site_city IS NOT NULL AND lat IS NOT NULL
GROUP BY site_city
HAVING count(*) >= 50;
`;

const OWNER = `
-- Owners reconciled by exact name and mailing address. Different spellings of
-- one owner stay separate: merging them would be a guess.
CREATE OR REPLACE TABLE owner AS
SELECT owner_id,
       min(owner_1) AS name,
       min(mailing_address) AS mailing_address,
       min(mailing_city) AS mailing_city,
       min(mailing_state) AS mailing_state,
       min(mailing_zip) AS mailing_zip,
       min(owner_location) AS owner_location,
       count(*) AS properties
FROM property WHERE owner_1 IS NOT NULL
GROUP BY owner_id;
`;

export async function buildModel(con: DuckDBConnection): Promise<void> {
  for (const sql of [PERMIT, PROPERTY, CONTRACTOR, OWNER, PLACE]) await con.run(sql);
}
