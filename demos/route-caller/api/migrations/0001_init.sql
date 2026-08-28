-- Route Caller phase 1 schema.
-- `capacity`, `license_no` and authoritative `is_home_daycare` land in phase 2
-- from state licensing data; they are nullable/defaulted until then.

CREATE TABLE routes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  start_address TEXT NOT NULL,
  end_address TEXT NOT NULL,
  polyline TEXT NOT NULL,
  osm_status TEXT DEFAULT 'ok',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE facilities (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES routes(id),
  name TEXT NOT NULL,
  address TEXT,
  city TEXT,
  zip TEXT,
  phone TEXT,
  lat REAL, lng REAL,
  capacity INTEGER,
  license_no TEXT,
  source TEXT NOT NULL,
  distance_from_route_m INTEGER,
  position_along_route_m INTEGER,
  is_franchise INTEGER DEFAULT 0,
  is_home_daycare INTEGER DEFAULT 0,
  status TEXT DEFAULT 'not_called',
  flagged INTEGER DEFAULT 0,
  notes TEXT DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_fac_route ON facilities(route_id);
