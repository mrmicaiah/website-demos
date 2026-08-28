-- A stable key for matching a Google result to a row we already have.
--
-- Enrichment has to decide whether an incoming Places result is a facility we
-- already store or a new one. Without a stable id that decision falls back to
-- normalized-name-within-150m, which is good but not certain. Capturing the
-- place id from now on (both at ingest and at enrich) means future enrichments
-- match on an exact key first and only fall back to name+geo for legacy rows.
--
-- Nullable: every row written before this migration has none, and OSM-only
-- rows never will.

ALTER TABLE facilities ADD COLUMN google_place_id TEXT;
CREATE INDEX idx_fac_place_id ON facilities(google_place_id);
