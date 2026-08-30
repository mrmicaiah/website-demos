# Area Caller

Vertizin's outbound acquisition engine. Where `route-caller` builds a call list
along a **drive**, this one builds it around an **area**: a town plus a radius.
The targets are local service trades — HVAC and plumbing first — and the caller
works a town, debriefs, and pulls the next one. Moving towns is a thirty-second
act.

Phase 1 (the list) and phase 2 (the workflow) are both shipped. Single user, no
auth.

## What it is for, and what that changes

Vertizin sells one $1,497/mo website package to established local service
businesses, 2–15 employees, with real job volume. Not to startups with no
history, not to price shoppers. The ideal first call is a long-established trade
business with a strong Google review presence and a weak or missing website.

Three consequences run through the whole tool:

- **"No website" is the headline, not a footnote.** It is a prominent green-flag
  badge, its own filter, the number on every area card, and the first term of
  the sort. It is styled as a *positive* signal — the opposite of
  route-caller's muted grey one — because here it is the entire pitch.
- **Review count is the "established business" proxy.** Google's rating and
  `userRatingCount` are captured on every row, shown on every card, and are the
  second term of the sort.
- **Franchises are junk here too**, because they already have corporate
  marketing, as are supply houses and big-box retail (Ferguson, Johnstone,
  Winsupply), which are a networking channel rather than a customer.

## Where it lives

```
demos/area-caller/                ← this folder: the static frontend (GitHub Pages)
  index.html  styles.css  app.js  config.js
  agenda.js                       ← date logic + calendar link; ALSO required by the tests

demos/route-caller/api/           ← ONE Worker, ONE D1, shared with route-caller
  src/areas/{handlers,pipeline,queries,google,enrich,classify,industries,leadScore}.js
  src/shared/{tiling,dedupe,names,snapshot}.js    ← genuinely shared, both pipelines
  migrations/0007_add_areas.sql  0008_area_pipeline.sql
  test/areas.test.mjs  test/workflow.test.mjs
```

`config.js` points at the same deployed Worker as route-caller. There is no
second Worker and no second database: the area endpoints live under `/api/areas`
and touch neither the `routes` nor the `facilities` table.

The frontend never sees an API key. Every Google call is proxied through the
Worker, where the key lives as the secret `GOOGLE_MAPS_API_KEY`. The map is
Leaflet + OpenStreetMap tiles, which need no key at all.

## How an area is pulled

1. Google Geocoding turns the town into a centre.
2. The disc is **tiled** — a square lattice of 16.1 km search circles at 16.1 km
   spacing, kept out to one step past the radius so the edge is genuinely
   covered. This is the same doctrine as route-caller's corridor tiling, and it
   lives in the same file (`src/shared/tiling.js`). A wide radius is not wide
   coverage: one Places search returns at most 20 results.
3. Each industry's Places types are **probed once** at the centre. If Places
   rejects them the industry falls back to text search per tile, for every one
   of its phrasings. (Measured: `hvac_contractor` does not exist in Places New.)
4. Per tile, per industry: one `searchNearby` (or one `searchText` per phrasing).
   Plus one broad text sweep per industry query over the whole area.
5. Dedupe by `google_place_id` first, name-within-150 m as fallback. A business
   found by both the HVAC and plumbing searches is **one row** carrying both
   industries, not two rows she calls twice.
6. Junk classification at ingest — flags only, nothing deleted.
7. Anything past the radius is dropped (the outer tiles overshoot on purpose).
8. Area and businesses are written to D1. The frontend reads D1 from then on.

**OpenStreetMap is deliberately not used here.** OSM's `craft=*` and
`shop=trade` coverage in the US is thin, it is the least reliable dependency in
route-caller (where it accounts for essentially all the wall time), and it
contributes nothing a Places search does not already have for the trades. That
is why an area pull takes ~5 s where a route ingest takes ~22–32 s.


## The pipeline — two gates, no gray zone

Micaiah's framing, and it governs everything below:

> The call has two gates: are they shopping for a website person, and will they
> book a brainstorm meeting right now. **If they don't book, they're out.** No
> nurture stages, no warming, no callback-for-the-maybe. "You're either ready or
> you're not."

| status | means |
| --- | --- |
| `not_called` | untouched |
| `no_answer` | rang out — retryable |
| `voicemail` | left a message — retryable |
| `out` | reached them, not ready. Covers "not shopping" AND "shopping but wouldn't book" |
| `meeting_set` | the brainstorm is booked. **The** pipeline milestone |
| `won` | signed |
| `lost` | the meeting happened (or no-showed) and didn't close |

There is deliberately **nothing between `meeting_set` and `out`**, and a test
asserts that no soft status ("interested", "warm", "nurture", "maybe",
"callback") is in the list — so a change has to argue with this section rather
than slip past it.

`meeting_set` is **rejected server-side without a `meeting_at`**. A booked
brainstorm with no time on it is the same gray zone wearing the milestone's
name. The UI asks for the time in the same interaction.

Terminal is not unreachable: `out` and `lost` mute rather than vanish, and every
status is reversible. And both dates go **inert, never deleted** — a
`meeting_at` on a row moved off `meeting_set`, or a `follow_up_date` on a row
that is now `out`, stays in the database and simply stops being surfaced.

### Dates are local wall-clock. Always.

`follow_up_date` is `'YYYY-MM-DD'` and `meeting_at` is `'YYYY-MM-DDTHH:MM'`.
**Neither is ever UTC.** He books "Tuesday 2pm" and it stays 2pm, including from
another state.

The Worker does **no date comparison at all** — it returns the strings verbatim
and the browser decides what "today" means against its own local date, in
`agenda.js`. That file never hands a date string to `new Date`, because
`new Date('2026-08-30')` parses as midnight UTC: west of Greenwich that silently
turns "due today" into "overdue" and makes today's meeting disappear from the
panel. Local dates are built with `new Date(y, m - 1, d)`, and a test pins it.

## The Today panel

One component, at the top of the landing page and at the top of each area's call
list (area-filtered there). **It is the reminder system** — no notifications, no
email, no digest, nothing to configure. Opening the tool tells him the day.

- **Meetings today**, earliest first, with the next 7 days collapsed behind one
  line. A meeting earlier today still shows: dropping it at 9:05 would hide the
  row that needs marking won or lost.
- **Follow-ups due** — today or overdue, **oldest first**, because the one that
  has waited longest is the one to call.
- Each row: tap-to-call, jump-to-card, and the calendar button on meetings.
- Empty state is one quiet line, not a big empty box.

## Calendar handoff

No integration, no OAuth, nothing to authenticate. Setting a meeting reveals an
**Add to Calendar** button — a prefilled `calendar.google.com/render` link,
titled "Brainstorm: {business}", 45 minutes by default, with the phone, the
address and a snapshot of the notes in the details.

The times carry **no trailing `Z`**, which is what tells Google to read them in
the calendar's own timezone — the same wall-clock promise the stored string
makes. A `Z` there would silently move the meeting.

## The funnel

Area cards carry one muted line under the lead count:

```
248 leads · 31 reached · 4 meetings · 1 won
```

Cumulative, visible-rows-only. Two counting decisions worth knowing:
**`reached` is any status except `not_called`** (a voicemail is progress through
the list), and **`meetings` counts `meeting_set` + `won` + `lost`** — counting
only `meeting_set` would make the funnel shrink as deals closed, which is the
opposite of what a funnel is for.

## Not being built (locked scope)

No email sequences. No deal values. No reminders or notifications. No
multi-user. No nurture stages. No automation. **The Today panel and the binary
pipeline ARE the workflow.**

## The lead score

Defined once, in `src/areas/leadScore.js`, which exports both the SQL fragment
the Worker orders by and the JS comparator the pipeline and the frontend sort
by. A test asserts SQL and JS produce the same order.

```
1. no website first        — the whole pitch
2. review count desc       — the established-business proxy
3. distance from centre asc
4. name                    — so the order is deterministic
```

A NULL review count is **not** zero. It means the Places Enterprise field mask
was unavailable on that run, so it sorts to the bottom of its website group
rather than pretending to be a business nobody has reviewed.

## Industries

A data file (`src/areas/industries.js`), so adding a trade later is data, not
code. The frontend reads the menu from `GET /api/industries` rather than keeping
a copy.

| industry | Places types | text queries |
| --- | --- | --- |
| HVAC | `hvac_contractor` — **rejected by Places, runs on text** | "HVAC contractor", "heating and air conditioning" |
| Plumbing | `plumber` | "plumbing company" |
| Roofing | `roofing_contractor` | "roofing company" |
| Electrical | `electrician` | — |
| Septic | none | "septic service", "septic pumping" |
| Tree service | none | "tree service" |
| Foundation / concrete | none | "foundation repair" |

## API

Base URL is the same deployed Worker as route-caller. CORS is open for
GET/POST/PATCH.

| Method | Path | Body / notes |
| --- | --- | --- |
| `GET` | `/api/industries` | the preset menu + radius presets |
| `POST` | `/api/areas` | `{ name, center_address, radius_m, industries[] }` → runs the pipeline, returns `{ area, facilities, meta }` |
| `GET` | `/api/areas` | areas with `facility_count`, `visible_count`, `no_website_count`, `called_count`, `flagged_count` |
| `GET` | `/api/areas/:id` | area + businesses in lead-score order |
| `POST` | `/api/areas/:id/enrich` | re-check in place: refresh review counts, insert newly found businesses, never touch status/flags/notes |
| `GET` | `/api/agenda` | meetings + due follow-ups across every area, for the Today panel |
| `PATCH` | `/api/area-facilities/:id` | `{ status?, flagged?, notes?, meeting_at?, follow_up_date? }` — `meeting_set` is refused without a `meeting_at` |

`meta` on a create reports the honest numbers: raw results, post-dedupe,
stored, no-website count, per-industry counts, review distribution, franchise
and supplier counts with sample names, tiles used, Places calls made,
**tile failures**, whether the lean field mask was hit, and the subrequest
budget.

`tile_failures` exists because of a real bug: Places Text Search rejects a
circle in `locationRestriction` (only a rectangle), so the first Huntsville
pilot lost every per-tile HVAC search to a silent 400 and returned 27 HVAC
companies where the fix returned 142. A search that silently returns nothing is
worse than one that fails loudly.

## Junk: flagged, never deleted

- **Franchises** are matched against an explicit **brand list**, never a name
  pattern. The deciding evidence: "Roto-Rooter" is a national franchise and
  "Rooter Man of Athens LLC" is somebody's independent shop — exactly the
  owner-operated business Vertizin sells to. A `/rooter/` pattern cannot tell
  them apart. The list is expanded from real data, as route-caller's childcare
  list was.
- **Suppliers and retail** are matched by brand, by shape (`… Plumbing Supply`,
  `… Wholesale`, `… Distributing`), and by Google `primaryType`. The type
  deny-list fails open: a row with no type is kept.

Both hide by default behind one collapsed "Hidden: N businesses" line with a
Restore per category. The rows never leave D1.

## Enrichment

`POST /api/areas/:id/enrich` re-checks an area she is already calling. Same
rails as route-caller, running the same shared code:

- `status`, `flagged`, `notes`, `name`, the geometry, the first-finder industry
  and **both pipeline dates** are protected columns — an update naming one
  throws. Re-checking a town must never move a booked meeting.
- `phone` and `website` fill only from NULL. She may have corrected a number,
  and a "no website" badge must not flip out from under her mid-call.
- `rating` and `review_count` **do** refresh. They are pure Google facts she
  never edits, and their staleness is the reason to re-check at all.
- `industries` only ever grows.
- Her columns are snapshotted before any write and verified against the database
  afterwards, in production, on every run.

Proven live on the Huntsville pilot: call state was planted on three rows,
106 businesses were inserted and 9 updated, and the planted status, flag and
notes came back byte-for-byte.

## Local development

```
cd demos/route-caller/api
npm test          # 271 checks — 126 route-caller, 145 area-caller
npm run dev       # local Worker
npm run deploy
npm run migrate:remote
```

Serve the frontend from the repo root with `python3 -m http.server` and open
<http://localhost:8000/demos/area-caller/>. With `apiBase` empty, the UI runs in
a clearly-labelled preview mode on sample data.
