# Route Caller

A two-person sales workflow tool: the salesperson drives a route, the in-house
caller works every child care facility within ~10 miles of that route **in drive
order** — tap-to-call, status, flags, and notes, all persisted in Cloudflare D1 so
progress survives across devices and sessions.

Phase 1. Single user, no auth.

```
demos/route-caller/
  index.html  styles.css  app.js  config.js   ← static frontend (GitHub Pages)
  api/                                        ← Cloudflare Worker + D1
    src/{index,geo,google,overpass,pipeline,heuristics,queries,enrich}.js
    src/shared/{tiling,dedupe,names,snapshot}.js   ← used by BOTH pipelines
    src/areas/…                                    ← the area-caller backend
    migrations/0001_init.sql … 0007_add_areas.sql
    test/geo.test.mjs  test/queries.test.mjs  test/enrich.test.mjs
    test/areas.test.mjs
```

**This Worker serves two products.** `demos/area-caller/` is a second frontend
over the same Worker and the same D1, using the `/api/areas` endpoints and the
`areas` / `area_facilities` tables. It touches nothing here: no route endpoint,
table or behaviour changes for it, and the 126 route-caller tests are the proof.
The modules under `src/shared/` are genuinely shared — the tiling doctrine, the
dedupe engine, name normalization, and the enrichment snapshot rails — so the
two pipelines cannot drift on the lessons that were expensive to learn.

The frontend never sees an API key. Every Google call is proxied through the
Worker, where the key lives as the secret `GOOGLE_MAPS_API_KEY`. The map is
Leaflet + OpenStreetMap tiles, which need no key at all.

## How a route is built

1. Google Geocoding turns the start and end addresses into coordinates.
2. Google Routes API (falling back to the legacy Directions API) returns the
   driving polyline.
3. The polyline is decoded, thinned to ~200 m spacing, and sampled every ~8 km
   (capped at 25 sample points, to stay inside the Worker subrequest budget).
4. Two searches run over that corridor:
   - **Google Places (New)** — `searchNearby` for `child_care_agency` and
     `preschool` at each sample point, radius 16 km, plus one `searchText` biased
     along the whole route.
   - **Overpass** — one batched query for `amenity=childcare`,
     `amenity=kindergarten` and `preschool=yes` within 16 km of the route
     linestring, with a User-Agent and a single retry on 429/504.
5. Results merge: same normalized name within 150 m is one facility, the record
   with a phone number wins, and `source` becomes `both` when Google and OSM
   agree.
6. Each facility gets `distance_from_route_m` (perpendicular distance to the
   polyline) and `position_along_route_m` (projection onto it — this is what
   drive order sorts on). Anything beyond 16 km is discarded.
7. Route and facilities are written to D1. The frontend reads from D1 from then on.

If Overpass is down the route is still built from Google alone, and the route row
records `osm_status`; the UI says so.

## API

Base URL is the deployed Worker. CORS is open for GET/POST/PATCH.

| Method | Path | Body / notes |
| --- | --- | --- |
| `POST` | `/api/routes` | `{ name, start_address, end_address }` → runs the pipeline, returns `{ route, facilities, meta }` |
| `GET` | `/api/routes` | routes with `facility_count`, `called_count`, `flagged_count` |
| `GET` | `/api/routes/:id` | route + facilities in drive order |
| `POST` | `/api/routes/:id/enrich` | re-check a route in place: update enrichment columns, insert newly found facilities, never touch status/flags/notes |
| `PATCH` | `/api/facilities/:id` | any of `{ status, flagged, notes }` → updated row |
| `GET` | `/api/health` | liveness + whether the Google secret is set |

`status` is one of `not_called`, `no_answer`, `voicemail`, `interested`,
`not_interested`.

`POST` also returns a `meta` block describing what the retail deny-list removed:

```json
"meta": {
  "excluded_retail": 6,
  "excluded_retail_raw": 20,
  "excluded_types": { "department_store": 14, "clothing_store": 3, "discount_store": 3 }
}
```

`excluded_retail` is the number of entries actually kept off the call list —
excluded candidates run through the same dedupe and corridor filter as the kept
ones. `excluded_retail_raw` is the candidate count behind it, which is larger
because overlapping corridor searches return the same store several times. The
Worker also logs the excluded names and types, visible in `wrangler tail`.

### The retail deny-list

Google occasionally types a big-box store as a child care result. Those rows are
dropped at ingest on `primaryType` alone — **never on the name** — and only for
unambiguous retail and commerce types. Churches, places of worship, community
centres, gyms and YMCAs, and schools are never excluded, because real child care
programs run inside all of them. A row with no `primaryType` (every OSM
candidate) is kept: the filter fails open.

Google's `primaryType` is stored on each facility as `primary_type`, so the
filter's decisions stay inspectable. Rows ingested before migration 0002 have
`NULL` there.

## Setup

### 1. Google Cloud

Enable these APIs on the project the key belongs to, and leave the key
restricted to them:

- **Geocoding API**
- **Routes API** (and/or **Directions API** — the Worker falls back to it)
- **Places API (New)**

The key is used only server-side, so restrict it by API rather than by HTTP
referrer.

### 2. Cloudflare

```bash
cd demos/route-caller/api

# Create the database (already done for this repo — id is in wrangler.toml)
npx wrangler d1 create route-caller-db

# Apply the schema
npx wrangler d1 migrations apply route-caller-db --remote

# Deploy the Worker
npx wrangler deploy

# Set the Google key — REQUIRED, the pipeline returns 503 without it
npx wrangler secret put GOOGLE_MAPS_API_KEY
```

`wrangler deploy` prints the `https://route-caller-api.<subdomain>.workers.dev`
URL. Put it in `demos/route-caller/config.js`:

```js
window.ROUTE_CALLER_CONFIG = {
  apiBase: 'https://route-caller-api.<subdomain>.workers.dev',
};
```

Until `apiBase` is set (or if the Worker is unreachable) the UI runs in **preview
mode**: a labelled banner plus five sample facilities, so the demo still renders
in the gallery. Nothing in preview mode is written anywhere.

### Local development

```bash
cd demos/route-caller/api
npx wrangler d1 migrations apply route-caller-db --local
npx wrangler dev            # http://localhost:8787
```

Point `config.js` at `http://localhost:8787` and serve the frontend with any
static server (`npx serve demos/route-caller`).

## Tests

```bash
cd demos/route-caller/api && npm test
```

**271 checks — 126 route-caller, 145 area-caller.** The 126 are unchanged from
before area-caller landed, which is how the shared-module extraction is known to
be behaviour-preserving.

Of the 126: 95 over the corridor math and merge logic: polyline decoding against
Google's reference string, haversine distances against known values,
perpendicular distance to a route, projection along it (including L-shaped
routes and points that clamp past either end), route simplification, sampling,
dedupe, the corridor filter, and the franchise / home-daycare heuristics.

## Notes and limits

- **Subrequest budget.** Workers cap subrequests per request (50 on the free
  plan). A route uses 2 geocodes + 1 routing + up to 25 nearby searches + 1 text
  search + 1–2 Overpass calls. `MAX_SAMPLES` in `src/index.js` is the dial: raise
  it on a paid plan for denser coverage of very long routes.
- **Places billing.** The field mask requests `nationalPhoneNumber` and
  `addressComponents` (Enterprise SKU). If the account rejects that mask the
  Worker retries automatically with a lean mask — you'll still get facilities,
  just fewer phone numbers.
- **Offline.** Failed `PATCH`es queue in `localStorage` and replay when the
  browser comes back online; the row updates locally either way.
- **Phase 2** adds state licensing enrichment — `capacity`, `license_no` and an
  authoritative `is_home_daycare`, matched by name + geo. The schema already has
  those columns; the capacity pill and "Biggest first" sort simply have nothing
  to show until then.
