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

Most demos are pure static mockups. **Two of them are not: `route-caller` and
`area-caller` are working sales tools with a live backend.**

They are **two frontends over ONE Cloudflare Worker and ONE D1 database**, both
living in `demos/route-caller/api/`. They share the Worker, the Google key, and
the modules under `api/src/shared/`. They share no tables. That structure was a
deliberate decision on 2026-08-29 — see "One Worker, one database, two
frontends" under the locked decisions.

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

### area-caller

**Vertizin's outbound acquisition engine.** Same caller-side workflow, different
unit of work and a different market: instead of a driving route, the unit is an
AREA — a town plus a radius. Instead of child care, the targets are local
service trades (HVAC and plumbing first). She pulls a list for a town, works the
calls, debriefs, and pulls the next town; moving towns must be a thirty-second
act.

- Frontend: `demos/area-caller/` — vanilla JS, no build step, on GitHub Pages.
- Backend: the `/api/areas` endpoints of the same Worker, in
  `demos/route-caller/api/src/areas/`.

**The business it serves, which settles most judgment calls here:** Vertizin
sells one $1,497/mo website package to established local service businesses,
2–15 employees, with real job volume. Explicitly not to startups with no
history and not to price shoppers. The ideal first call is a long-established
trade business with a strong Google review presence and a weak or missing
website. When a rule is ambiguous here, ask who could actually justify $1,497 a
month — the way route-caller asks who could actually buy a playground.

## The people

- **Micaiah** owns the repository and is the only person who pushes to `origin`.
- **The end user is a single in-house caller.** She is not Micaiah, she will not
  read this file, and she works the list on a phone with one thumb. She already
  works from an existing call-list artifact, **and its UI is the design
  reference** — route-caller was built to match what she is already fluent in,
  not to improve on it. When a design question comes up, "what does her
  reference do" outranks taste. **area-caller reuses that shell deliberately** —
  same header card, same card anatomy, same one-thumb operation — so moving
  between the two products costs her nothing.
- **What she sells: playground equipment, to child care facilities.** This is the
  fact that settles most judgment calls, so reason from it rather than from
  "child care" in the abstract. It is why a facility with no outdoor space is a
  poor prospect and a church running a preschool is a good one; why a Montessori
  school is a customer and a public elementary school is not; why "no website"
  is a signal she wants to see rather than a gap to hide. When a rule is
  ambiguous, ask who could actually buy a playground.
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

Doctrine that applies to **both** products is marked **[shared]**. Where it is
shared, it is shared in CODE too — `api/src/shared/` — not copied.

**One Worker, one database, two frontends** *(2026-08-29)*

- The area-caller spec left the backend shape to the builder and offered a new
  Worker or a new D1. It was **overruled deliberately**: one D1, one Worker, two
  frontends. `areas` and `area_facilities` are migration `0007` in
  route-caller's existing chain, and the `/api/areas` endpoints live in the same
  Worker.
- The reason is that the alternative buys nothing and costs a fork. A second
  Worker would need its own copy of the Google secret, its own deploy, its own
  version history, and — worst — its own copy of the tiling, dedupe and
  snapshot logic, which is exactly the code that has been most expensive to get
  right and that both pipelines most need to keep in step.
- The constraint that motivated the split proposal — *route-caller's live tables
  must not move* — is met by additivity instead: the area endpoints read and
  write only `areas` and `area_facilities`, migration `0007` touches no existing
  table, and **the whole pre-existing test suite passes unchanged** as the proof.
  That is a stronger guarantee than separation, because it is checked on every
  run rather than assumed.
- **Shared means shared, not copied.** `src/shared/tiling.js`,
  `dedupe.js`, `names.js` and `snapshot.js` are used by both pipelines. If you
  find yourself about to copy one with a "source: …" header comment, don't.

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

**Enrich, never re-ingest, once a list has been worked [shared]**

- **A route with call activity is never re-ingested.** Re-ingesting deletes and
  rebuilds its rows, which destroys her status, flags and notes. Instead,
  `POST /api/routes/:id/enrich` updates the enrichment columns of existing rows
  in place, inserts newly discovered facilities alongside them, widens
  `routes.corridor_m`, and deletes nothing.
- **Enrichment may only write enrichment columns.** `status`, `flagged`,
  `notes`, `name`, `id` and the geometry are off limits, enforced by
  `assertPatchIsSafe` rather than left to care. `phone`, `website` and
  `primary_type` fill only from NULL — she may have corrected a number or be
  dialling it right now. `playground_nearby` only ever goes 0 → 1, because
  Overpass is often partial and a missing playground is not evidence of none.
- **Every run snapshots her columns before writing and verifies them after**,
  in production, not only in tests. The rails themselves live in
  `src/shared/snapshot.js` and `POST /api/areas/:id/enrich` runs the same code. A failed verification is reported loudly in
  the response and logged as an error.
- **Ambiguous matches update nothing.** When an incoming result matches two
  stored rows, guessing would write one facility's data onto another's row on a
  route she is calling. They are reported for review instead.

**Ingest wide, filter narrow**

- **The full 30-mile corridor is ingested and stored; the UI narrows it.** Her
  call: widening the view must never require re-searching a route. Every
  facility stores its true `distance_from_route_m`, and the header's distance
  lens (30 mi default / 20 / 10) filters on that client-side, instantly.
- **A wide corridor is not a wide search radius. [shared]** One Places nearby search
  returns at most 20 results, so a 30-mile radius in a dense area returns the
  nearest 20 and never reaches the edge — measured, it collapsed a route's whole
  result set inside 4.2 miles, worse than the 10-mile corridor it replaced. The
  corridor is therefore **tiled**: each along-route sample gets search points
  offset perpendicular at ±1 and ±2 lateral steps, each searched at a 16.1 km
  radius, so the circles overlap and the outer ring reaches 30 miles. If you
  ever widen the corridor again, widen the tiling, not the radius. area-caller
  tiles a DISC rather than a corridor, with the same 16.1 km circle at the same
  spacing, from the same file.
- **`routes.corridor_m` records what a route was actually ingested at**, and the
  UI disables lens options beyond it. A route ingested at 10 miles must say so
  rather than offer three options that show identical rows.

**Who gets hidden, and why it is always a toggle**

- **Hiding is never deleting. [shared]** Franchises, home daycares, schools and colleges,
  and no-outdoor-play shapes are all flags on the row. The data stays in D1. A
  preference is not a fact about the world, and today's "don't show me these"
  becomes next year's lead list.
- **She never has to press anything to get a clean list. [shared]** As of 2026-08-28 the
  junk categories are hidden by default with no toggles to manage: a single
  collapsed line above the list says how many were hidden and why, a Show
  control expands them as muted rows, and each carries a Restore for its
  category. Junk management is assumed; the status dropdown, search and distance
  lens remain, because those are lenses, not junk management.
- **Early childhood is a prospect; school-age and older is not — private
  included.** Her decision, 2026-08-28, second round of feedback. It
  **supersedes** the earlier public-versus-private rule, which had been
  protecting exactly the prep schools, country day schools and parochial
  academies she wanted gone. The line is developmental, not public/private:
  daycare, preschool, childcare and pre-K Montessori are her market; anything
  serving school-age children or older, including private prep schools and
  anything college-related, is not.
  - `is_school_program` keeps its column name but now means
    **school-age-or-higher**, not "public school".
  - The **early-childhood guard is the only veto** and beats every other signal:
    preschool, pre-K, daycare, child care, childcare, early learning, nursery,
    Montessori, or a `child_care_agency` / `preschool` type. Real rows are why —
    "The Connecticut College Children's Program", "Just 4 The Kids Daycare
    College" and "Applebrook Country Day School" are all her customers despite
    their names.
  - **Head Start is the one exception that outranks the veto**, because she
    asked for it hidden in her first round and that instruction still stands.
  - A bare `school` type is Google's catch-all and yields to an
    early-childhood-adjacent name (learning, children's, weekday, ministry,
    development center). Stronger types do not.
  - **Ambiguous rows stay visible** and get reported to her, never guessed at.
- **That asymmetry is the general rule for this whole class of heuristic.
  [shared]** When unsure whether to hide, don't.

**Playground signals are signals, not facts**

- `playground_nearby` means OpenStreetMap has a playground mapped within 100 m.
  A 0 means "not mapped", never "not there" — OSM coverage of private
  playgrounds is thin. So a positive renders a badge and a negative renders
  nothing; there is no "no playground" badge and no toggle on it.
- `playground_unlikely` is a structural guess about facility *shape* — tutoring,
  music, dance, martial arts, swim — and it is deliberately conservative. It
  never fires on anything Google types `child_care_agency` or `preschool`, and
  never on a name carrying a child-care word. Gyms, YMCAs and gymnastics centres
  are excluded from it on purpose: they run children's programs and buy.

**Ordering**

- **Drive order is the three-key tuple: `position_along_route_m`, then
  `distance_from_route_m`, then `name`.** Facilities beside or behind a route
  endpoint all clamp to the same position, so without the tiebreak a whole
  cluster comes back in arbitrary order. Distance breaks it (nearest first,
  which is how you actually work a cluster); name makes it fully deterministic.
  The same tuple is applied in the SQL `ORDER BY`, in the pipeline before
  insert, and in the frontend's sort, so the three never disagree.

**area-caller: the lead score, and what "no website" means here**

- **"No website" is the headline, not a footnote.** In route-caller a missing
  website is one prospecting signal among several and renders as a muted grey
  badge. In area-caller it is the entire pitch — Vertizin sells a website — so
  it is a **green-flag badge**, the first term of the sort, its own filter, and
  the number printed on every area card. Same data, opposite emphasis, on
  purpose.
- **The lead score is defined in exactly one place**, `src/areas/leadScore.js`,
  which exports both the SQL fragment the Worker orders by and the JS comparator
  the pipeline and the frontend use. A test asserts the two produce the same
  order against real SQLite. It is: no website first, then review count
  descending, then distance from centre, then name.
- **Review count is the established-business proxy**, and it is why the field
  mask asks for `rating` and `userRatingCount`. It bills in the same Places
  Enterprise tier as the phone number this account already pays for.
- **A NULL review count is not zero.** It means the Enterprise mask was
  unavailable on that run. It sorts to the bottom of its group and renders as
  "no rating", never as a business nobody has reviewed. Same reasoning as
  `playground_nearby`: absence of data is not data.
- **Franchises are matched against an explicit brand list, never a name
  pattern.** The deciding evidence is one pair: "Roto-Rooter" is a national
  franchise and "Rooter Man of Athens LLC" is somebody's independent shop —
  precisely the owner-operated business Vertizin sells to. A `/rooter/` pattern
  flags both. The same trap sits under "one hour", "benjamin franklin" and "mr".
  Expect to expand the list from real data, as the childcare list was expanded.
  Suppliers are the one place a shape rule is allowed (`… Plumbing Supply`,
  `… Wholesale`, `… Distributing`), because supply houses announce themselves.
- **Overpass is deliberately not used for areas.** OSM's `craft=*` coverage in
  the US is thin, it is the least reliable dependency in route-caller, and it is
  essentially all of route-caller's wall time. Skipping it is why an area pull
  takes ~5 s where a route ingest takes 22–32 s. This is a considered omission,
  not an oversight.
- **A Places type is a hope, not a fact.** Measured 2026-08-29: `hvac_contractor`
  does not exist in Places (New) and 400s the whole nearby call. So each
  industry's types are probed once at the centre and the industry falls back to
  text search per tile if they are rejected. A stale type name costs one wasted
  call, never an empty area.
- **A search that silently returns nothing is worse than one that fails loudly.**
  Places Text Search rejects a circle in `locationRestriction` — only a
  rectangle — and the first Huntsville pilot lost every per-tile HVAC search to
  a swallowed 400: 45 extra calls, byte-identical results, 27 HVAC companies
  instead of 142. Tile failures are now counted and reported in `meta`, and the
  UI surfaces them.

**UI**

- **The UI must match the caller's reference design.** Deep green header card
  (#2E5B41) with a navy route badge; a large green tap-to-call button that is a
  real `tel:` link; a capacity pill **only when capacity is non-null**; a
  dashed-border notes field placeholdered "Decision maker, callback, current
  equipment age". Mobile-first, one-thumb operation. Franchises and home
  daycares hidden by default but flippable — never discarded from the data.
