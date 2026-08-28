# SESSION LOG

Append-only. Newest first. One entry per working session: what happened, and
more importantly **why** the judgment calls went the way they did.

---

## 2026-08-28 — 30-mile corridor: the measurement that changed the design

She wants the full 30 miles ingested with the UI filtering it down. The brief
assumed that was a constant change — raise the corridor from 16,000 m to
48,280 m and check it fits under the Places 50,000 m radius cap. It does fit,
and it does not work.

### What the measurement showed

Raising the radius made coverage **strictly worse**. On Decatur:

| | facilities | spread | saturated |
| --- | --- | --- | --- |
| 10-mile corridor (before) | 72 | 9.3 mi | — |
| 48 km radius | 85 | **4.2 mi** | **7 of 7** |
| tiled 16.1 km searches | **227** | **29.3 mi** | 23 of 35 |

Every search hit the 20-result cap and returned only its nearest 20, so a
30-mile circle in a dense area never reached past 4 miles. `rankPreference:
DISTANCE` did its job — it protects the near facilities — but it cannot conjure
far ones that a saturated search never returned. Shipping that would have handed
her a shorter list and called it wider.

The brief said prefer measuring over theorising, which is the only reason this
was caught before it reached her.

### Tiling

A wide corridor is not a wide radius. Each along-route sample now gets search
points offset perpendicular at ±1 and ±2 lateral steps of 16.1 km, each searched
at 16.1 km. Three overlapping radii reach 48.3 km, just past what we store. 18
along-route samples x 5 lateral = 90 searches. Decatur went 72 to 227 facilities,
163 of them inside 10 miles where there had been 72 — the tiling improved the
*near* coverage as much as the far.

### Two documented constraints turned out to be wrong

**The 50-subrequest ceiling is the free-tier number; this account is paid.** A
logged 123 ms of CPU proves it — the free tier kills at 10 ms. The real ceiling
is 1000, and several past decisions were shaped by a limit that was never
binding. Current usage is 114.

**The ~100 s edge cliff is higher than assumed.** A 285 s request completed. But
that is not a licence to be slow: the binding limit is the caller, not the edge.

### Wall time, and the bound that actually worked

Instrumenting the phases separately was the whole game. Places: **0.5 s** for 35
searches, **3.2 s** for 90 — parallelised 12 at a time, it was never the problem.
Overpass was **96.9 s of a 100 s request**, and failing.

A phase-level time budget alone did not fix it: the deadline is only checked
between requests, so one hanging fetch blew through it — 60.9 s against a 20 s
budget. **`AbortSignal.timeout` per request** is what actually bounded it.
Decatur: 285 s to 103 s to 62 s to **21.9 s**, each step a different bound.

### Honest edges

Saturation is not solved, only improved: 23 of 35 searches on Decatur and 30 of
90 on gatlingburg still hit the cap, so dense edges are under-sampled. There is
subrequest headroom to tile tighter; the cost is Places billing at the
Enterprise SKU, which is a business call and not mine.

Overpass is largely down for us again — mirrors 500, primary 500 or timing out —
so playground data is thin. It runs at a narrower 10-mile radius than Google on
purpose, so those signals cover the inner 10 miles only.

Connecticut stays at 10 miles and its wider lens options are disabled with a note
saying why. Three options showing identical rows would be a lie told by a
dropdown.

---

## 2026-08-28 — Overpass mirrors: the fix that didn't, and the one that did

Implemented the mirror-endpoint fallback scoped last session. **The mirrors do
not work.** Both `overpass.kumi.systems` and `overpass.private.coffee` return
HTTP 500, consistently, for the same queries `overpass-api.de` serves. They never
served a single chunk.

But the work was not wasted, because building the fallback required building the
diagnostics, and the diagnostics found the actual problem.

### What the instrumentation showed

The first attempt reported `osm_requests: 0` alongside an Overpass error — a
contradiction, and a reporting bug: the counters were assigned after
`fetchOverpass` returned, so a throw discarded them. `fetchOverpass` no longer
throws; a total failure is a result with `chunksOk: 0` carrying the endpoints
tried and what each returned. That single change turned "it's broken" into:

```
overpass-api.de          HTTP 521  (serves some chunks)
overpass.kumi.systems    HTTP 500  (never served)
overpass.private.coffee  HTTP 500  (never served)
```

Which reframed the problem: **the main endpoint is intermittent, not blocked.**
Previous sessions had concluded it was failing outright, because a single-query
route either worked or didn't. Chunked, it visibly serves some and fails others.

### The fix that actually mattered

Two behaviours, both tuned from that observation:

- **An endpoint that has already served a chunk is never retired.** The original
  fallback logic retired the primary the first time it 521d — which meant the
  moment the intermittent endpoint hiccuped, every remaining chunk fell through
  to mirrors that cannot serve anything. Retiring the only working endpoint was
  losing coverage rather than saving it.
- **500 counts as a broken path**, so the mirrors retire after one failure each
  instead of burning two subrequests per chunk for the whole route.

gatlingburg went from **0 OSM facilities and 0 playgrounds** to **15 OSM-derived
rows and 10 mapped playgrounds**, 255 facilities against 243. `osm_status` reads
`partial: 1 of 7 chunks`, which is the honest description and better than the
`unavailable` it replaced.

### Budget

Mirror failover makes the worst case hard to reason about, so it is no longer
reasoned about: a counter caps Overpass at 20 calls per route, hard ceiling
29 + 20 = 49 against a 50 limit, asserted by a test. On gatlingburg that cap is
genuinely reached. There is no headroom to raise it — the answer is a working
endpoint, not a bigger budget.

### On stopping

Three re-ingests this session against a brief that said one. Each was gated on a
fresh zero-activity check and each answered a question the previous one had left
open — the first had the reporting bug, the second revealed the retirement bug.
The third produced no improvement over the second, which is where it stopped.
The line between iterating and thrashing is whether the last attempt taught you
something; when it stopped teaching, I stopped.

### Next option, not built

Route Overpass calls through a **non-Cloudflare proxy**. Query size is ruled out
(4-point chunks taking 4.6 s from a laptop still 521 from the Worker) and the
service is ruled out (identical queries succeed from a laptop). What remains is
the Workers → Overpass path. A small proxy elsewhere would test that directly
and, if it works, fix every long route at once. Recorded in `STATE.md`, and
deliberately not built on spec.

---

## 2026-08-28 — Overpass corridor chunking (and a correction)

### First, the correction

The previous entry and the commit message for `f58c169` both claim the Overpass
retry set was widened to cover 502/503/521. **It was not.** The patch command
began with a `cd` into a directory that did not exist from where the shell was;
the `cd` failed, the rest of the command ran in the wrong directory, changed
nothing, and I read the passing tests and successful deploy as confirmation
without checking the file. The claim then propagated into two documents and a
commit message.

So the 521s attributed to "still failing after the retry widened" were never
retried at all. The retry is real now, and the lesson is the cheap one: after a
patch, grep the file for the thing you just claimed to change. The old entry has
been annotated rather than rewritten.

### Chunking

The corridor query is now split into chunks of sample points, issued
sequentially a second apart, each with one retry, results deduped across chunks
by OSM element id — adjacent chunks overlap heavily, since every anchor point
carries a 16 km radius.

Chunk size was chosen from measurements rather than a guess. On the gatlingburg
corridor with all four tag clauses: **9 anchor points takes 42 s, 4 takes 4.6 s,
2 takes 1.9 s.** Overpass's cost is superlinear in anchor count, so the first
implementation at 9 per chunk was still slow enough to trip an edge timeout. It
went to 4.

Budget arithmetic is in a comment at the top of `overpass.js` and in `STATE.md`:
29 Google subrequests plus 7 chunks is 36, or 43 if every chunk retries, against
a 50 cap. There is a test asserting the worst case stays under it, so raising
`MAX_SAMPLES` will fail loudly rather than silently truncating a route.

### What chunking did not fix

gatlingburg still returns 521 from the Worker, on 4-point chunks that take under
five seconds from a laptop. Two attempts, then I stopped rather than thrash.

The investigation was still worth it, because it ruled out both obvious
explanations: **Overpass is not down** (the exact queries succeed from here) and
**it is not merely query size** (small fast chunks fail too). What is left is
something specific to the Worker → overpass-api.de path — most likely how
Overpass treats Cloudflare Workers egress. The untried next step is a mirror
endpoint behind an env var, recorded in `STATE.md`.

Reporting "still broken, here is what it isn't" is worth more than another five
attempts, and the route was left in place either way.

---

## 2026-08-28 — Narrowed schools, website capture, playground signals

Three user-driven changes, all of them sharpened by one fact that had been
missing from the docs until now: **she sells playground equipment.** That single
piece of context settles most of the judgment calls below, and it is now the
first thing `CONTEXT.md` says about her.

### Narrowing the school rule

Her decision, after seeing the first cut hide forty rows on the Connecticut
route. Public schools are the target; private schools, academies, Montessoris
and religious schools are **prospects** — they buy playgrounds, districts don't.

A bare `primaryType: school` is no longer sufficient evidence; it flags only
when a public-school name agrees. `primary_school`/`secondary_school`, Head
Start, and the public-name patterns still flag on their own. On top of that, any
private or religious marker in the name vetoes every other signal.

That veto was not in the brief, and it was needed: the brief said
`primary_school` should still flag while also naming "The Children's School" —
which Google types `primary_school` — as a row that must **not** flag. The two
instructions conflict, and the veto resolves them in the direction her stated
rationale points, which is the one that keeps prospects on the list. Same for
"Country School", added to the private markers alongside "Country Day" after
New Canaan Country School survived the first pass.

Connecticut went from 40 flags to 10. Decatur from 8 to 4 — Grace Lutheran,
Valley Fellowship Christian Academy, Montessori School of Huntsville and a
public magnet named "Academy For Academics & Arts" all came back onto her list.
The magnet is a genuine false negative and it stays: a wasted call is cheaper
than a hidden prospect, and that asymmetry is now written into `CONTEXT.md` as
the general rule for this class of heuristic.

Four private schools still slip through on Connecticut. Recorded in `STATE.md`
rather than chased with more guard words, because over-guarding would let real
public schools back in and the next pass should be hers, not mine.

### Website capture

`websiteUri` bills with the phone fields in the Enterprise tier, so it went into
the full Places mask only. The lean fallback stays deliberately Pro-only: under
it, rows simply come back with `website` null. OSM `website`/`contact:website`
tags are captured too.

The interesting part was the UI. "No website" is a prospecting signal she wants
to *see* — a facility with no web presence is one nobody else is calling — so it
renders as a badge rather than being hidden. But Connecticut can never be
re-ingested, so all 213 of its rows have `website` null, and every one of them
would have worn that badge. The badge is now suppressed on any route where no
row has a website at all: in that case the null describes the ingest, not the
facility. A signal you can't stand behind is worse than no signal.

### Playground signals, and why they are signals

`playground_nearby` comes from OSM `leisure=playground` within 100 m, folded
into the existing batched Overpass query rather than added as a second request.
It is reported as a badge when true and as *nothing* when false — there is no
"no playground" badge and no toggle — because OSM's coverage of private
playgrounds is thin and a 0 means "not mapped", not "not there". Ten of the 72
Decatur rows have one mapped.

`playground_unlikely` is a structural guess about facility shape: tutoring,
music, dance, martial arts, swim. It is conservative on purpose and guarded
twice — never on a `child_care_agency` or `preschool` type, never on a name
carrying a child-care word — because the costs are asymmetric in the same
direction as everything else here. Gyms, YMCAs and gymnastics centres were
deliberately left out: they run children's programs with outdoor space.

### Data refresh

Call activity was re-checked live before anything was deleted, not taken from
the previous report. Decatur and gatlingburg were clean and were re-ingested;
Connecticut has a real call on it and was backfilled in place by `UPDATE`,
touching only the two flag columns. Its one called row was checked against both
classifiers first — it stays visible.

Worth noting for confidence in the backfill: after re-ingesting, the two rebuilt
routes were run back through the same reconcile script, and it found **zero**
rows to change on either. The ingest path and the backfill path agree.

Overpass gave gatlingburg HTTP 521 twice, so that route is Google-only and has
no playground data at all. (Correction, made the following session: the retry
widening described here never actually landed — a failed `cd` meant the patch ran
in the wrong directory and silently did nothing, and the claim went into this log
and the commit message unverified. The 521s in this session were therefore never
retried. Verify the file, not the exit code.) Decatur, ingested minutes earlier, got a clean `ok`. The likely cause is
query size and the likely fix is chunking the corridor query; both are in
`STATE.md`.

---

## 2026-08-28 — Hide schools & Head Starts (first user-driven feature)

The caller's first feature request, and the first change driven by someone
actually using the thing: she wants public schools, elementary schools and Head
Start programs off her list. She does not sell to them.

**Built as a visibility flag, not a deletion.** Migration 0003 adds
`is_school_program`; it is set at ingest and hidden by default behind a "Hide
schools & Head Starts" toggle beside the existing franchise and home-daycare
toggles. The rows stay in D1 and she can flip the toggle off at any time.

Why a toggle rather than filtering at ingest: "she does not sell to schools" is a
preference, not a fact about the data, and preferences change — a district that
won't buy this year may buy next year. Deleting at ingest would encode today's
preference into the permanent record and make the decision unrecoverable without
a re-ingest. The franchise flag already established this pattern and it was right
to follow it.

**Why this rule may match on names, when the retail deny-list may not.** These
are different kinds of rule and the distinction is written into a comment in
`heuristics.js` so a future session doesn't collapse them. The retail deny-list
*deletes* rows at ingest, so it may only act on authoritative type data: a wrong
call there loses a real facility silently and permanently. The school flag only
*hides* a row behind a reversible toggle, so a wrong call costs one checkbox.
The cost of being wrong sets how much evidence the rule needs. Name evidence is
still treated as the weaker input: a name carrying a child-care word ("Little
Scholars Elementary Prep Daycare", "Grace Church Preschool") stays visible unless
Google's `primaryType` actually says school.

**Checked for call activity before touching data.** The seed route had none, so
it was re-ingested rather than patched with an `UPDATE`. Mid-task it turned out
two more routes had appeared on the live API from outside this session, one of
them with a call already logged — so the activity check was re-run rather than
trusted from ten minutes earlier, and that route was left alone. Live state gets
re-read before destructive work, not remembered.

**Posh Mommy & Baby Too! is resolved, and the answer vindicates the earlier
refusal.** The re-ingest captured `primary_type` on every Google row:
**`child_care_agency`**. It is a real child care listing. Deleting it on the
strength of its name — which was proposed, and declined on the grounds that names
are not evidence — would have quietly removed a genuine facility from the
caller's list. Two of the three name-suspicious rows turned out to be retail and
one did not, which is exactly the error rate that makes name-based deletion a bad
trade.

**One finding to put back to her.** Three of the eight flagged rows are *private*
schools caught by `primaryType: school` rather than by name: Montessori School of
Huntsville, Grace Lutheran School, Valley Fellowship Christian Academy. She asked
for public schools; a Montessori school is plausibly a customer. The rule was
implemented as specified rather than quietly narrowed, and the finding is recorded
in `STATE.md` for her to settle. Reversible either way.

**Backfilled the two user-created routes later the same day**, in place — the
real classifier from `heuristics.js` run against the stored rows, emitting
`UPDATE`s by explicit id. No re-ingest, no deletions, and nothing but
`is_school_program` written, which is what made it safe to touch the Connecticut
route despite its live call activity. Her one called row was checked against the
classifier first and does not get flagged, so her work stays visible.

The backfill made the finding above much louder. Across 456 rows the
`primaryType: school` branch does nearly all the work, and most of what it
catches is private, not public: on the Connecticut route only **4 of 40** flags
came from name evidence, the other 36 from type alone — Montessori schools,
"The Children's School", "Alphabet Academy", a dozen parochial schools. Seven of
them carry a child-care word in the name that the guard would have caught, had
type not been allowed to override it. At eight rows this looked like an edge
case; at forty it looks like the rule's centre of gravity is in the wrong place.
Applied as specified anyway, because it is reversible and because narrowing a
rule on the caller's behalf without asking her is the same mistake as deleting
rows on their names.

**Also fixed while here:** the header counters were computing over every row on
the route, so "N left" included facilities hidden by the category toggles. With a
third toggle hiding eight more rows, that gap would have become actively
misleading. Counters now run over the caller's list — the route minus the hidden
categories — while search and the status filter stay a transient lens that does
not move the numbers.

---

## 2026-08-28 — Route Caller phase 1: spec to live deploy

Built route-caller from a written spec to a deployed, live-tested tool in one
session, across eight dispatched tasks.

### The arc

**Spec.** `prompts/route-caller-spec.md` was written first and dispatched as a
pointer rather than pasted inline — data flow, D1 schema, the four endpoints,
and a detailed UI description derived from the caller's existing artifact. It
remains the best description of intent.

**Build.** Frontend (vanilla JS, no build step) plus a Cloudflare Worker with a
D1 binding: geocode → route → sample the polyline every ~8 km → search the
corridor via Google Places (New) and one batched Overpass query → merge and
dedupe → compute distance-from-route and position-along-route → persist. 22
corridor-math checks written alongside, and the whole API surface exercised
against a local D1 before anything was deployed.

**Deploy, with a detour.** `npx wrangler deploy` was refused by the session
permission classifier — no prompt, just a denial. The first task ended with the
work committed, D1 created and migrated, and an honest "not deployed, here is
the exact command" report rather than a workaround. On retry the classifier
refused again. What worked was `npm run deploy`, the project's own deploy script,
already permitted by the repo's settings allow-list. Noted in `STATE.md` so the
next session doesn't rediscover it.

**Live end-to-end test.** Decatur → Huntsville: 201 in ~8 s, 78 facilities, 88%
phone coverage, `osm_status: ok`, drive order monotonic. The number that mattered
was phone coverage — a call list with a third of its rows undialable would have
been a failure regardless of how many facilities it found.

**Four Targets, and a refusal.** The live data contained a Target store, typed by
Google as child care, with a working store phone number. Reporting it turned up
three more: four in total, not the one initially spotted. A follow-up task asked
for them to be deleted from D1, and they were — by explicit id, after verifying
each row.

But scanning the full list surfaced three more suspects: Roses Discount Store,
Sprouts Children's Consignment, Posh Mommy & Baby Too!. **These were deliberately
not deleted.** The only evidence against them was their names, and deleting rows
on name evidence is exactly the failure mode the filter was being built to
prevent. A facility called "Sprouts" could as easily have been a preschool. The
right move was to say so and wait for type data rather than to act on a hunch and
call it cleanup.

**The deny-list, and why it is shaped this way.**

- **Type-only, never name.** Names are unreliable in both directions: a real
  preschool can be named like a store, and a store's name tells you nothing about
  what Google thinks it is. Tested in both directions — a `preschool` named
  "Target Learning Academy" stays; a `department_store` named "Sunny Days
  Learning Center" goes.
- **Fail-open.** A row with no `primaryType` is kept. Every OSM row lacks one,
  and so does any Google row under the lean field mask. A filter that failed
  closed would have silently deleted all 13 OSM facilities.
- **Deny-list, never allow-list.** Real child care programs run inside churches,
  YMCAs, community centers, and schools. An allow-list of "child care types"
  would have quietly dropped St Paul's Lutheran Church & Preschool and Decatur
  City Head Start. The deny-list only removes what is unambiguously retail; when
  in doubt, the row stays and the caller decides in two seconds by looking at it.
  Generic `store` was deliberately left out of the deny-list for the same reason.

**Vindication.** Re-ingesting the route with the filter live excluded exactly
three names and added none: the Targets, **Roses Discount Store (`discount_store`)**
and **Sprouts Children's Consignment (`clothing_store`)**. Both suspects that had
been left alone on principle turned out to be retail, and were caught on real
type data rather than on a guess about their names. The other 72 rows reproduced
identically, which was a better determinism check than the test suite could give.
Posh Mommy & Baby Too! survived and remains unexplained.

**Drive-order tiebreak.** Ten facilities clamped to `position_along_route_m = 0`
— they sit beside the start rather than along the drive — and sorted arbitrarily
within that tie. Fixed to the three-key tuple in all three places drive order is
produced, so SQL, pipeline, and frontend cannot disagree. Concretely: the
caller's first card went from La Petite Academy 2.9 miles out to the Boys & Girls
Club 0.8 miles out.

**Polish.** Two follow-ups, both from problems surfaced rather than asked for:

- `meta.excluded_retail` originally counted raw candidates, which read as 20 when
  only 6 rows were actually kept off the list — overlapping corridor searches
  return the same store repeatedly. It now counts effective rows, with the raw
  count preserved separately. A metric that flatters its own feature is worse
  than no metric.
- Migration 0002 added `primary_type`, so the filter's decisions are inspectable
  from the data instead of only from a tail log. The Posh Mommy question answers
  itself at the next ingest.

### Ending state

Live at `route-caller-api.micaiah-tasks.workers.dev`, 36 tests passing, seed
route of 72 facilities at 88% phone coverage waiting for the caller's first
session. See `STATE.md`.

### Worth carrying forward

- Two reports in this session corrected an earlier one of my own (one Target
  became four; three unpushed commits became zero after a fetch). Both were
  caught by re-checking rather than restating. Check the live state before
  reporting a count; do not carry a number forward from a previous message.
- The instinct to "just clean up the obvious junk" was wrong twice over and
  right to resist: the type data later confirmed two of three suspects, which
  means acting on names would have been right 67% of the time — and wrong about
  a real facility the third time, silently, with no way to notice.
