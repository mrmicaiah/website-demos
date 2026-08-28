# Route Caller — Build Spec (Phase 1)

## What this is

A tool for a two-person sales workflow: a salesperson drives a route; an in-house caller phones every child care facility within ~10 miles of that route, in drive order. The caller enters a start and end address, the tool finds facilities along the corridor, and presents them as a mobile-first call list with tap-to-call, status tracking, flags, and notes — persisted in Cloudflare D1 so progress survives across devices and sessions.

Single user for now. No auth in phase 1.

## Where it lives

- Frontend: `demos/route-caller/` (static — index.html + app.js + styles.css, or a single-file build; keep it dependency-light). Register it in `demos.json` and the gallery like the existing demo.
- Backend: `demos/route-caller/api/` — a Cloudflare Worker (wrangler project) with a D1 binding. The Google API key lives ONLY as a Worker secret (`GOOGLE_MAPS_API_KEY`), never in frontend code.
- Map rendering in the browser uses Leaflet + OpenStreetMap tiles (no key needed client-side). All Google API calls are proxied through the Worker.

## Data flow

1. User submits route name + start address + end address.
2. Worker: Google Geocoding API → coords for both. Google Directions/Routes API → driving route polyline.
3. Worker decodes the polyline, samples points every ~8 km along it, and runs corridor searches:
   - Google Places API: nearby/text search for child care / daycare / preschool categories around each sample point, radius 16 km (10 mi). If using Places API (New), prefer `searchText` with `searchAlongRouteParameters` where practical, still enforcing our own 10-mile corridor filter.
   - Overpass API (https://overpass-api.de): nodes/ways tagged `amenity=childcare`, `amenity=kindergarten`, plus `preschool=yes`, within the same corridor (bounding boxes around sample points are fine, then exact distance filter).
4. Merge + dedupe: same normalized name within 150 m = same facility; prefer the record with a phone number; record `source` = google | osm | both.
5. For each facility compute: `distance_from_route_m` (min distance to polyline) and `position_along_route_m` (projection onto the route — this powers drive-order sorting). Discard anything beyond 16 km from the polyline.
6. Persist route + facilities to D1. Return the route id; frontend loads the call list from D1 thereafter.

Note Overpass etiquette: single batched query where possible, set a User-Agent, handle 429 with one retry after a pause. If Overpass fails entirely, proceed with Google-only results and note it in the route record (`osm_status` field).

## D1 schema

```sql
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
  capacity INTEGER,            -- from state licensing when available (phase 2); NULL otherwise
  license_no TEXT,             -- same
  source TEXT NOT NULL,        -- google | osm | both
  distance_from_route_m INTEGER,
  position_along_route_m INTEGER,
  is_franchise INTEGER DEFAULT 0,   -- heuristic, see below
  is_home_daycare INTEGER DEFAULT 0,
  status TEXT DEFAULT 'not_called', -- not_called | no_answer | voicemail | interested | not_interested
  flagged INTEGER DEFAULT 0,
  notes TEXT DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_fac_route ON facilities(route_id);
```

Franchise heuristic: name matches a list of national chains (KinderCare, The Goddard School, Primrose, La Petite Academy, Childtime, Tutor Time, The Learning Experience, Bright Horizons, Children's Lighthouse, Kiddie Academy, Lightbridge, Big Blue Marble). Home-daycare heuristic: OSM tags indicating in-home, or name patterns like "Family Child Care", "'s Family Daycare", "In-Home". These set flags — the UI filters on them, data is never discarded.

## Worker API (JSON, CORS open to GET/POST/PATCH from the Pages origin)

- `POST /api/routes` — body: { name, start_address, end_address } → runs the whole pipeline, returns { route, facilities }
- `GET /api/routes` — list routes with facility counts + called counts
- `GET /api/routes/:id` — route + its facilities
- `PATCH /api/facilities/:id` — body may contain { status, flagged, notes } → returns updated row

## UI — match the reference the user already works with

There is a screenshot-derived reference the user loves; replicate its feel exactly. Mobile-first, one-thumb operation. Style notes:

- Header card: deep green (#2E5B41 range), rounded corners. Left: small navy rounded badge showing a short route label (e.g. "I-95" — derive from route name, editable later). Title: "{Route name} — Call List" in bold white. Subtitle line in lighter green-white: summary of active filters/sort (e.g. "Sorted by drive order · franchises and home daycares hidden").
- Inside header: search input (placeholder "Search name, town, ZIP") + a filter dropdown (All / Not called / Called / Flagged / Interested).
- Counter row in header: "N called · N left · N flagged" with the numbers bold.
- Facility cards on off-white background: white rounded cards, each with:
  - Left checkbox = mark called (checking sets status to a quick "called" — implement as status no_answer prompt-free: checkbox toggles between not_called and a generic called state; the status dropdown refines it).
  - Name in bold + capacity pill badge on the right ("114 kids", light green pill) — ONLY when capacity is non-null.
  - Second line, gray: "City ZIP · LICENSE-NO" (license only when present). Add a tiny source badge (G / OSM / both) at low visual weight.
  - Big green phone button with the number — a tel: link, large tap target.
  - Star icon next to phone = flag toggle (filled when flagged).
  - Notes: dashed-border textarea, placeholder "Decision maker, callback, current equipment age". Autosave on blur (PATCH), debounce.
  - A small status dropdown (Not called / No answer / Voicemail / Interested / Not interested).
- Sort toggle: "Drive order" ↔ "Biggest first" (capacity desc, NULLs last). Default drive order.
- Filter toggles for "hide franchises" and "hide home daycares" (default ON to match her current list, but flippable).
- Sticky footer bar: "Capacity = state licensed max. Verify on the call." + a "Clear" link (clears search/filters, not data).
- Optional collapsible map panel (Leaflet): route polyline + facility pins, tap a pin to scroll to its card. Keep it collapsed by default on mobile.
- New Route screen: name, start address, end address, Go — with a loading state ("Finding facilities along your route…") since the pipeline takes several seconds. Landing view lists existing routes with progress (e.g. "12 of 27 called").

Persist UI state (active route, sort, filters) in localStorage; all call data lives in D1.

## Deployment

1. Scaffold the wrangler project in `demos/route-caller/api/` with `wrangler.toml` (D1 binding `DB`), a migration file with the schema above, and the Worker code.
2. If wrangler is authenticated on this machine: create the D1 database (`wrangler d1 create route-caller-db`), apply the migration, deploy the Worker, and set the frontend's API base URL to the deployed workers.dev URL (put it in a small `config.js`).
3. The user must run `wrangler secret put GOOGLE_MAPS_API_KEY` (they have the key). Write a `demos/route-caller/README.md` documenting: required Google APIs to enable (Geocoding, Directions/Routes, Places), the secret command, and the deploy commands — so it's reproducible.
4. If wrangler auth is unavailable, still write everything, and list the exact commands for the user in the README + your report.

## Phase 2 (do NOT build now, but don't paint us into a corner)

State licensing enrichment: per-state tables of licensed facilities (capacity, license number, facility type) matched to found facilities by name+geo, populating `capacity` / `license_no` / `is_home_daycare` with authoritative data. Schema above already accommodates it.

## Quality bar

- No frameworks required; vanilla JS is fine. Keep it readable.
- Graceful errors: geocoding failure, zero results, Overpass down, offline PATCH retry.
- Test the corridor math with a unit-style check (distance + projection functions) — a tiny test file run with node is fine.
- Commit but do not push.
