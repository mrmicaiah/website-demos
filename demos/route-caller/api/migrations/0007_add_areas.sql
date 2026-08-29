-- Area Caller: the second product on this Worker and this database.
--
-- ONE database, ONE Worker, TWO frontends. `routes` and `facilities` are
-- untouched by this migration and by every area endpoint — she is actively
-- calling from them. Areas are a parallel pair of tables.
--
-- The unit of work is an AREA (a town plus a radius) rather than a drive, and
-- the targets are local service trades rather than child care. What carries
-- over unchanged is the doctrine: junk is FLAGGED, never deleted; a missing
-- website is a headline prospecting signal, not a gap; and the caller's
-- status/flagged/notes columns are hers.

CREATE TABLE areas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,              -- "Huntsville pilot", "Athens HVAC"
  center_address TEXT NOT NULL,
  center_lat REAL, center_lng REAL,
  radius_m INTEGER NOT NULL,       -- user-chosen: 10/20/30 mi presets
  industries TEXT NOT NULL,        -- JSON array of industry keys pulled
  osm_status TEXT DEFAULT 'ok',    -- unused in phase 1; see the omission note in CONTEXT.md
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE area_facilities (
  id TEXT PRIMARY KEY,
  area_id TEXT NOT NULL REFERENCES areas(id),
  google_place_id TEXT,
  industry TEXT NOT NULL,          -- the industry search that found it FIRST
  -- Every industry that found it, comma-separated. An HVAC company that also
  -- does plumbing is one row found twice, not two rows; the chips filter on
  -- this column so she still sees it under both.
  industries TEXT,
  name TEXT NOT NULL,
  address TEXT, city TEXT, zip TEXT,
  phone TEXT, website TEXT,
  lat REAL, lng REAL,
  -- Google's rating and review count. review_count is the "established
  -- business" proxy that decides whether Vertizin's package is sellable here,
  -- so it is a first-class column and it feeds the lead score. NULL means the
  -- Enterprise field mask was unavailable on that run, never "no reviews".
  rating REAL, review_count INTEGER,
  primary_type TEXT,
  distance_from_center_m INTEGER,
  -- Flags, not deletions. Franchises have corporate marketing and suppliers
  -- are a networking channel, so both are hidden by default and both are one
  -- tap from coming back.
  is_franchise INTEGER DEFAULT 0,
  is_supplier_or_retail INTEGER DEFAULT 0,
  status TEXT DEFAULT 'not_called',
  flagged INTEGER DEFAULT 0,
  notes TEXT DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_area_fac_area ON area_facilities(area_id);
CREATE INDEX idx_area_fac_place ON area_facilities(google_place_id);
