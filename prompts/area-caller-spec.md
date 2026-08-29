# Area Caller — Build Spec (Phase 1)

## What this is

A sibling to route-caller, purpose-built as Vertizin's outbound acquisition engine. Instead of a driving route, the unit of work is an AREA: a town/address plus a radius. Instead of childcare, the targets are local service trades (HVAC and plumbing first). The user pulls a list for a town, works the calls, debriefs, and pulls the next town — moving towns must be a thirty-second act.

The caller-side workflow, UI feel, and all hard-won doctrine (assumed hides, honest metrics, evidence-over-names, enrich-not-reingest, snapshot rails, hiding-is-never-deleting) carry over from route-caller. Read route-caller's code and CONTEXT.md before starting; reuse aggressively.

## Business context (from the Vertizin proposal — this drives judgment calls)

Vertizin sells one $1,497/mo website package to established local service businesses, 2–15 employees, with real job volume. Explicitly NOT for: startups with no history, price shoppers. The ideal first call: a long-established trade business with strong Google review presence and a weak or missing website. Therefore in THIS tool, unlike route-caller:

- **"No website" is a headline lead signal, not a footnote.** Prominent badge, dedicated filter, and it feeds the lead-score sort.
- **Review count is the "established business" proxy.** Capture and display Google rating + userRatingCount on every card.
- Franchises are junk here too (they have corporate marketing), as are big-box retail and supply houses (Ferguson, Johnstone, Winsupply — networking channels, not customers).

## Where it lives

- Frontend: `demos/area-caller/` — clone route-caller's UI shell and adapt. Register in `demos.json`.
- Backend: extend a decision to the builder with a constraint: **route-caller's deployed Worker and D1 tables must remain untouched and stable — she is actively calling from it.** Preferred shape: a NEW wrangler project at `demos/area-caller/api/` with its own Worker, sharing the same D1 database via new tables (areas, area_facilities) OR a new D1 database — builder's call, document the reasoning. Shared modules (geo, overpass, heuristics patterns, snapshot rails) may be copied with a header comment naming the source file, or extracted to a shared folder if clean; do not refactor route-caller's live code to share.

## Data model

```sql
CREATE TABLE areas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,              -- "Huntsville pilot", "Athens HVAC"
  center_address TEXT NOT NULL,
  center_lat REAL, center_lng REAL,
  radius_m INTEGER NOT NULL,       -- user-chosen: 10/20/30 mi presets
  industries TEXT NOT NULL,        -- JSON array of industry keys pulled
  osm_status TEXT DEFAULT 'ok',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE area_facilities (
  id TEXT PRIMARY KEY,
  area_id TEXT NOT NULL REFERENCES areas(id),
  google_place_id TEXT,
  industry TEXT NOT NULL,          -- which industry search found it
  name TEXT NOT NULL,
  address TEXT, city TEXT, zip TEXT,
  phone TEXT, website TEXT,
  lat REAL, lng REAL,
  rating REAL, review_count INTEGER,
  primary_type TEXT,
  distance_from_center_m INTEGER,
  is_franchise INTEGER DEFAULT 0,
  is_supplier_or_retail INTEGER DEFAULT 0,
  status TEXT DEFAULT 'not_called',
  flagged INTEGER DEFAULT 0,
  notes TEXT DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now'))
);
```

A facility found by two industry searches (HVAC + plumbing — common) dedupes by google_place_id into ONE row; `industry` becomes the first finder and a small `industries` JSON column or comma list records all finders (builder's call on shape; filterable either way).

## Industries

A preset menu, each mapping to Google Places includedTypes plus one or two text-search queries for coverage:

- **HVAC** — types: hvac_contractor (verify exact current type names against Places API (New) docs before hardcoding); text: "HVAC contractor", "heating and air"
- **Plumbing** — plumber; text: "plumbing company"
- **Roofing** — roofing_contractor; text: "roofing company"
- **Electrical** — electrician
- **Septic** — text: "septic service", "septic pumping" (no clean type)
- **Tree service** — text: "tree service"
- **Foundation/concrete** — text: "foundation repair"

Multi-select at area creation (default: HVAC + Plumbing pre-checked). Structure the industry definitions as a data file so adding one later is data, not code.

## Pipeline

1. Geocode center. Tile the circle (reuse route-caller's tiling lesson: overlapping 16.1 km searches, NEVER one big radius — the 20-result cap makes wide radii return less; this is locked doctrine) out to the chosen radius.
2. Per tile, per selected industry: Places searchNearby with the industry's types, rankPreference DISTANCE, plus the industry's text searches once per area (not per tile) at large radius.
3. Field mask: everything route-caller uses PLUS rating, userRatingCount, websiteUri. Verify SKU tiers; keep a lean fallback that degrades gracefully (no rating/website = NULL, never a failed area).
4. Dedupe by google_place_id first (we have it from birth here), name+150m fallback. Distance from center computed and stored.
5. Junk classification at ingest, flags only: franchise list for the trades (One Hour Heating, Aire Serv, Mr. Rooter, Roto-Rooter, Benjamin Franklin Plumbing, ARS/Rescue Rooter, TruGreen-class nationals — seed a reasonable list, expect to expand from real data like we did for childcare) and supplier/retail (Ferguson, Johnstone, Winsupply, Lowe's, Home Depot, hardware_store/home_improvement_store types).
6. Overpass: skip for phase 1 — OSM adds little for trades (craft=* tags are sparse in the US) and it's our least reliable dependency. Note in docs as a considered omission.
7. Persist. Same subrequest counting discipline; budget = tiles × industries × types + text searches; enforce with a counter and a test, cap tiles if needed, report the math.

## UI — route-caller's shell, re-aimed

- Landing: area cards. "New area" form: name, town/address, radius preset (10/20/30 mi), industry checkboxes. "N places to call" leads, raw total demoted, same as route-caller.
- Call list: same header/card anatomy. Differences:
  - **Industry chips** in the header (All / HVAC / Plumbing / …) — filter, persisted.
  - **Sort options:** Lead score (default) / Distance / Most reviewed / A-Z. Lead score = no-website first, then review_count desc, then distance asc — the Vertizin ideal customer floats to the top. Document the formula in one place.
  - **Card:** name, rating ★ + review count, city, distance from center, phone button, NO WEBSITE badge (prominent, positive-signal styling — this is a green flag not a gray one) or a subdued website link if one exists, flag star, notes, status dropdown. Notes placeholder: "Owner name, current marketing spend, callback".
  - Assumed hides: franchises + suppliers/retail, one "Hidden: N" line with Show/Restore, exactly the route-caller pattern.
- Map: pins around center circle, collapsed by default, same as route-caller.

## Enrichment

Port the enrich endpoint pattern (snapshot rails and all) — but phase 1 may ship without it IF the schema stores google_place_id from birth (it does) so enrichment can be added cleanly. Builder's call on including it now vs next; if deferred, say so in STATE.md.

## Tests

Same standards: tiling math, dedupe by place_id and by name+geo, industry mapping shapes, junk classifier both directions (Roto-Rooter flagged; "Rooter Man of Athens LLC" independent — decide from evidence whether name patterns are safe here or franchise-list-only; note the hiding-not-deleting bar applies), lead-score sort ordering including NULL review counts, subrequest budget assertion, the SQL count pattern with real SQLite for area cards' visible_count. Full suite green.

## Execute

After deploy + secret reuse (same Google key; if a new Worker, the user must run wrangler secret put again — put it in the report as a user action), pull the pilot area LIVE: name "Huntsville pilot", center "Huntsville, AL", 30 mi, HVAC + Plumbing. Report: totals, per-industry counts, no-website count (the number Micaiah cares most about), review-count distribution rough shape, franchise/supplier flags with sample names, saturation observations, wall time, cost math (searches × SKU tier so Micaiah can see the per-area Google cost).

## Docs

This is a second product in the repo: CONTEXT.md gains an area-caller section (what it is, the Vertizin context, the lead-score doctrine) and marks shared doctrine as shared; STATE.md gains an area-caller section with its own route/area table; SESSION_LOG.md entry. Update README/gallery. Commit but do not push.
