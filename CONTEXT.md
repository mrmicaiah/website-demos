# CONTEXT

Durable orientation for this repository. Changes rarely — if something here is
wrong, fix it here rather than working around it. For current status see
`STATE.md`; for how we got here see `SESSION_LOG.md`.

## What this project is

**website-demos** is a showcase repository of self-contained static demo sites,
served from GitHub Pages, indexed by a data-driven gallery at the repo root
(`index.html` reads `demos.json`; each entry is a slug, name, description, and
thumbnail, and links to `./demos/<slug>/`). Adding a demo means adding a folder
and one entry in `demos.json`.

Most demos are pure static mockups. **The current flagship is `route-caller`,
and it is not a mockup — it is a working tool with a live backend.**

### route-caller

A two-person sales workflow. The salesperson drives a route; an in-house caller
phones every child care facility within ~10 miles of that route, **in drive
order**. The caller enters a start and end address; the tool finds the
facilities along the corridor and presents them as a mobile-first call list with
tap-to-call, status tracking, flags, and notes.

- Frontend: `demos/route-caller/` — vanilla JS, no build step, on GitHub Pages.
- Backend: `demos/route-caller/api/` — a Cloudflare Worker with a D1 database.

Phase 1 is single-user with no auth. Phase 2 is state licensing enrichment
(authoritative `capacity`, `license_no`, `is_home_daycare`); the schema already
has those columns and the UI already renders them when non-null.

## The people

- **Micaiah** owns the repository and is the only person who pushes to `origin`.
- **The end user is a single in-house caller.** She is not Micaiah, she will not
  read this file, and she works the list on a phone with one thumb. She already
  works from an existing call-list artifact, **and its UI is the design
  reference** — route-caller was built to match what she is already fluent in,
  not to improve on it. When a design question comes up, "what does her
  reference do" outranks taste.
- **Claude Code workers** (you) do the building.

## Operating model

- A **manager chat in a Studio87 pane** dispatches work to a Claude Code worker
  as PROMPT blocks delivered through a mailbox: a worker reads an inbox file,
  does the work, and writes its full answer to an outbox file (temp file, then
  atomic `mv`, so the watcher never sees a partial write). The outbox contents
  are what the manager receives, verbatim — no preamble, no headers.
- **Large specs go in `prompts/`** and are dispatched as pointers rather than
  pasted inline. `prompts/route-caller-spec.md` is the phase 1 spec and is still
  the best single description of what route-caller is meant to be.
- **Workers commit but never push. Micaiah pushes manually.** Do not push, and
  do not add remotes or rewrite history to work around it.
- Manager-side MCP tooling can write to GitHub directly. See the gotcha about
  divergence in `STATE.md`.

## Locked decisions

These were decided deliberately. Each has cost something to get right. Change
them only with a reason better than the one recorded here.

**Secrets and keys**

- **The Google Maps API key lives only as a Worker secret** (`GOOGLE_MAPS_API_KEY`),
  never in frontend code, never in `config.js`, never in a `var`. Every Google
  call is proxied through the Worker. A key in a static file on GitHub Pages is
  a key that is published.
- **Map rendering is Leaflet + OpenStreetMap tiles**, so no client-side key
  exists to leak in the first place. This is why the map is OSM and not Google.

**Facility data**

- **Sources are Google Places (New) merged with Overpass/OSM.** Google carries
  phone coverage (~98% of its rows); OSM contributes facilities Google does not
  return at all. Neither alone is good enough for a call list.
- **Dedupe is same-normalized-name within 150 m, and the phone-bearing record
  wins.** `source` becomes `both` when the two agree. A caller cannot dial a
  row with no number, so the phone decides which record survives.
- **Retail junk is filtered by a deny-list on `primaryType` only — never by
  name.** It fails open: a row with no `primaryType` (every OSM row, and Google
  rows under the lean field mask) is kept. It **never** excludes churches,
  places of worship, community centers, gyms/fitness centers (where YMCAs land),
  or schools of any kind, because real child care programs run inside all of
  them. Only unambiguous retail and commerce types are dropped. Filtering on
  names would silently delete legitimate facilities whose names happen to look
  commercial; filtering on type asks the question we actually mean.
- Google's `primaryType` is stored on each row as `primary_type` so the
  deny-list's decisions stay inspectable after the fact.

**Storage**

- **D1 is the source of truth for all call data** — status, flags, notes. That
  is what lets the caller switch devices mid-route without losing progress.
- **localStorage holds UI preferences only** (active route, sort, filters, map
  open/closed) plus a replay queue for `PATCH`es that failed while offline.
  Never call data.

**Ordering**

- **Drive order is the three-key tuple: `position_along_route_m`, then
  `distance_from_route_m`, then `name`.** Facilities beside or behind a route
  endpoint all clamp to the same position, so without the tiebreak a whole
  cluster comes back in arbitrary order. Distance breaks it (nearest first,
  which is how you actually work a cluster); name makes it fully deterministic.
  The same tuple is applied in the SQL `ORDER BY`, in the pipeline before
  insert, and in the frontend's sort, so the three never disagree.

**UI**

- **The UI must match the caller's reference design.** Deep green header card
  (#2E5B41) with a navy route badge; a large green tap-to-call button that is a
  real `tel:` link; a capacity pill **only when capacity is non-null**; a
  dashed-border notes field placeholdered "Decision maker, callback, current
  equipment age". Mobile-first, one-thumb operation. Franchises and home
  daycares hidden by default but flippable — never discarded from the data.
