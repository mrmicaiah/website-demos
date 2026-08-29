// Area Caller: tiling, dedupe, industry shapes, junk classification, the lead
// score (in JS and in SQL), the subrequest budget, and the enrichment rails.
// Run: node test/areas.test.mjs

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { haversineMeters } from '../src/geo.js';
import { TILE_RADIUS_M, tileCircle, discIsCovered } from '../src/shared/tiling.js';
import { dedupeCandidates } from '../src/shared/dedupe.js';
import { normalizeName } from '../src/shared/names.js';
import {
  INDUSTRIES,
  DEFAULT_INDUSTRY_KEYS,
  resolveIndustries,
  industryByKey,
} from '../src/areas/industries.js';
import { isTradeFranchise, isSupplierOrRetail } from '../src/areas/classify.js';
import { tileRectangle } from '../src/areas/google.js';
import { byLeadScore, SORTS, LEAD_SCORE_ORDER_BY } from '../src/areas/leadScore.js';
import {
  mergeAreaCandidates,
  placeInArea,
  countByIndustry,
  reviewDistribution,
  noWebsiteCount,
} from '../src/areas/pipeline.js';
import { AREA_LIST_SQL, AREA_FACILITIES_SQL } from '../src/areas/queries.js';
import {
  matchAreaCandidates,
  areaEnrichmentPatch,
  assertAreaPatchIsSafe,
  AREA_PROTECTED_COLUMNS,
  snapshotOf,
  verifySnapshot,
} from '../src/areas/enrich.js';
import {
  tileBudget,
  searchesPerTile,
  subrequestBudget,
  MAX_TILES,
  MAX_TILE_SEARCHES,
  SUBREQUEST_CEILING,
  RADIUS_PRESETS_M,
} from '../src/areas/handlers.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

let passed = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures.push(`${label}: ${err.message}`);
    console.log(`FAIL  ${label}\n      ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || 'mismatch'}: got ${a}, expected ${b}`);
}

function freshDb() {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
  }
  return db;
}

const HUNTSVILLE = { lat: 34.7304, lng: -86.5861 };
const MILE = 1609.34;

/* ---------------------------------------------------------------- tiling -- */
console.log('\ntiling the disc');

check('the tile radius is the SHARED one, not an area-caller copy', () => {
  eq(TILE_RADIUS_M, 16100);
});

check('a 30-mile area tiles into a manageable number of searches', () => {
  const tiles = tileCircle(HUNTSVILLE, 30 * MILE, TILE_RADIUS_M);
  assert(tiles.length > 30 && tiles.length < 60, `got ${tiles.length} tiles`);
});

for (const miles of [10, 20, 30]) {
  check(`every point inside a ${miles}-mile area falls inside some tile`, () => {
    const radius = miles * MILE;
    const tiles = tileCircle(HUNTSVILLE, radius, TILE_RADIUS_M);
    assert(
      discIsCovered(HUNTSVILLE, radius, tiles, TILE_RADIUS_M),
      'the tiling leaves a gap — a business there would never be found'
    );
  });
}

check('tiles are returned nearest-first, so a cap sheds the EDGE not the middle', () => {
  const tiles = tileCircle(HUNTSVILLE, 30 * MILE, TILE_RADIUS_M);
  const distances = tiles.map((t) => haversineMeters(HUNTSVILLE, t));
  for (let i = 1; i < distances.length; i++) {
    assert(distances[i] >= distances[i - 1] - 1, 'tiles are not ordered by distance');
  }
  eq(Math.round(distances[0]), 0, 'the first tile is the centre');
});

check('maxTiles caps the count and keeps the nearest tiles', () => {
  const all = tileCircle(HUNTSVILLE, 30 * MILE, TILE_RADIUS_M);
  const capped = tileCircle(HUNTSVILLE, 30 * MILE, TILE_RADIUS_M, 12);
  eq(capped.length, 12);
  eq(capped, all.slice(0, 12));
});

check('a wide radius makes MORE tiles, never a wider single search', () => {
  const ten = tileCircle(HUNTSVILLE, 10 * MILE, TILE_RADIUS_M).length;
  const thirty = tileCircle(HUNTSVILLE, 30 * MILE, TILE_RADIUS_M).length;
  assert(thirty > ten * 3, `10mi=${ten} 30mi=${thirty} — coverage must grow with area`);
});

check('a tile rectangle contains its circle — Text Search takes no circle', () => {
  // The bug this test exists for: Places Text Search rejects a circle in
  // locationRestriction, so every per-tile HVAC search in the first pilot 400'd
  // silently. The rectangle must at minimum enclose the tile's radius.
  const rect = tileRectangle(HUNTSVILLE, TILE_RADIUS_M);
  assert(rect.low.latitude < HUNTSVILLE.lat && rect.high.latitude > HUNTSVILLE.lat);
  assert(rect.low.longitude < HUNTSVILLE.lng && rect.high.longitude > HUNTSVILLE.lng);
  const north = { lat: rect.high.latitude, lng: HUNTSVILLE.lng };
  const east = { lat: HUNTSVILLE.lat, lng: rect.high.longitude };
  assert(haversineMeters(HUNTSVILLE, north) >= TILE_RADIUS_M - 1, 'rectangle too short');
  assert(haversineMeters(HUNTSVILLE, east) >= TILE_RADIUS_M - 1, 'rectangle too narrow');
});

/* ---------------------------------------------------------------- dedupe -- */
console.log('\ndedupe');

const cand = (over = {}) => ({
  googlePlaceId: null,
  industry: 'hvac',
  industries: ['hvac'],
  name: 'Acme Heating',
  lat: 34.73,
  lng: -86.58,
  phone: null,
  website: null,
  rating: null,
  reviewCount: null,
  primaryType: null,
  ...over,
});

check('the same place id from two industry searches is ONE row', () => {
  const merged = mergeAreaCandidates([
    [cand({ googlePlaceId: 'p1', industry: 'hvac', industries: ['hvac'] })],
    [cand({ googlePlaceId: 'p1', industry: 'plumbing', industries: ['plumbing'] })],
  ]);
  eq(merged.length, 1);
  eq(merged[0].industries, ['hvac', 'plumbing'], 'both finders are recorded');
});

check('place id beats a differing display name', () => {
  const merged = mergeAreaCandidates([
    [cand({ googlePlaceId: 'p1', name: 'Acme Heating' })],
    [cand({ googlePlaceId: 'p1', name: 'Acme Heating & Air LLC', industries: ['plumbing'] })],
  ]);
  eq(merged.length, 1);
  eq(merged[0].name, 'Acme Heating');
});

check('two different businesses at the same address stay two rows', () => {
  const merged = mergeAreaCandidates([
    [cand({ googlePlaceId: 'p1', name: 'Acme Heating' })],
    [cand({ googlePlaceId: 'p2', name: 'Zenith Plumbing' })],
  ]);
  eq(merged.length, 2);
});

check('no place id falls back to name within 150 m', () => {
  const merged = mergeAreaCandidates([
    [cand({ name: 'Acme Heating' })],
    [cand({ name: 'ACME Heating, Inc.', lat: 34.7301, lng: -86.58 })],
  ]);
  eq(merged.length, 1);
});

check('the same name 5 km apart is two businesses, not one', () => {
  const merged = mergeAreaCandidates([
    [cand({ name: 'Acme Heating' })],
    [cand({ name: 'Acme Heating', lat: 34.78, lng: -86.58 })],
  ]);
  eq(merged.length, 2);
});

check('a duplicate fills gaps without overwriting what we already have', () => {
  const merged = mergeAreaCandidates([
    [cand({ googlePlaceId: 'p1', phone: '(256) 555-0100', website: null, reviewCount: 210 })],
    [cand({ googlePlaceId: 'p1', phone: '(256) 555-9999', website: 'https://acme.example', reviewCount: 5 })],
  ]);
  eq(merged[0].phone, '(256) 555-0100', 'the first phone wins');
  eq(merged[0].website, 'https://acme.example', 'a NULL website is filled');
  eq(merged[0].reviewCount, 210, 'an existing review count is not clobbered');
});

check('the shared engine is genuinely shared — no stable key means name+geo only', () => {
  const merged = dedupeCandidates(
    [[cand({ name: 'Acme' })], [cand({ name: 'Acme' })]],
    { absorb: () => {} }
  );
  eq(merged.length, 1);
  eq(normalizeName('ACME Heating, Inc.'), 'acme heating');
});

/* ------------------------------------------------------------ industries -- */
console.log('\nindustry definitions');

check('industry keys are unique', () => {
  const keys = INDUSTRIES.map((i) => i.key);
  eq(new Set(keys).size, keys.length);
});

check('every industry has the shape the pipeline reads', () => {
  for (const i of INDUSTRIES) {
    assert(typeof i.key === 'string' && i.key, `${i.key}: key`);
    assert(typeof i.label === 'string' && i.label, `${i.key}: label`);
    assert(Array.isArray(i.types), `${i.key}: types must be an array`);
    assert(Array.isArray(i.textQueries), `${i.key}: textQueries must be an array`);
    assert(Array.isArray(i.tileQueries) && i.tileQueries.length, `${i.key}: needs tileQueries`);
  }
});

check('an industry with no Places type still has a way to be searched', () => {
  for (const i of INDUSTRIES.filter((x) => !x.types.length)) {
    assert(i.tileQueries.length, `${i.key} would return nothing`);
  }
});

check('HVAC carries a second phrasing, because its Places type does not exist', () => {
  // Measured live 2026-08-29: `hvac_contractor` is rejected by Places (New), so
  // HVAC always runs on text — and one phrase found 27 companies where two
  // found far more, because half of them are named "... Heating and Air".
  const hvac = industryByKey('hvac');
  assert(hvac.tileQueries.length >= 2, 'HVAC needs more than one phrasing');
});

check('HVAC and Plumbing are the pre-checked defaults', () => {
  eq(DEFAULT_INDUSTRY_KEYS, ['hvac', 'plumbing']);
});

check('unknown industry keys are rejected, not silently dropped', () => {
  const { industries, unknown } = resolveIndustries(['hvac', 'unicorns']);
  eq(industries.map((i) => i.key), ['hvac']);
  eq(unknown, ['unicorns']);
});

check('resolveIndustries preserves menu order regardless of request order', () => {
  const { industries } = resolveIndustries(['plumbing', 'hvac']);
  eq(industries.map((i) => i.key), ['hvac', 'plumbing']);
});

check('industryByKey finds a definition and returns null for a miss', () => {
  eq(industryByKey('hvac').label, 'HVAC');
  eq(industryByKey('nope'), null);
});

/* ------------------------------------------------------------- junk flags -- */
console.log('\njunk classification, both directions');

for (const name of [
  'Roto-Rooter Plumbing & Water Cleanup',
  'Mr. Rooter Plumbing of Huntsville',
  'One Hour Heating & Air Conditioning',
  'Benjamin Franklin Plumbing',
  'Aire Serv of Madison',
  'ARS / Rescue Rooter',
  'TruGreen Lawn Care',
  'Mister Sparky Electric',
]) {
  check(`franchise flagged: ${name}`, () => assert(isTradeFranchise(name)));
}

for (const name of [
  'Rooter Man of Athens LLC',
  'Ferguson & Sons Heating and Cooling',
  "Bob's One Stop Plumbing",
  'Huntsville Heating & Air',
  'Franklin Plumbing of Decatur',
  'Sparky Electric Co',
  'Airtron Heating & Air',
  'A-1 Rooter Service',
]) {
  check(`independent NOT flagged: ${name}`, () => assert(!isTradeFranchise(name)));
}

check('the franchise rule is a brand LIST, not a name pattern', () => {
  // The deciding pair. A /rooter/ pattern flags both; only a brand list can
  // tell the national franchise from somebody's shop.
  assert(isTradeFranchise('Roto-Rooter Plumbing'), 'Roto-Rooter is a franchise');
  assert(!isTradeFranchise('Rooter Man of Athens LLC'), 'Rooter Man of Athens is not');
});

for (const [name, type] of [
  ['Ferguson Plumbing Supply', null],
  ['Johnstone Supply Huntsville', null],
  ['Winsupply of Madison', null],
  ['Gulf Coast Plumbing Supply', null],
  ['Southern HVAC Wholesale', null],
  ['Baker Distributing Company', null],
  ['The Home Depot', 'home_improvement_store'],
  ['Anytown Trading Post', 'hardware_store'],
]) {
  check(`supplier/retail flagged: ${name}`, () => assert(isSupplierOrRetail(name, type)));
}

for (const [name, type] of [
  ['Ferguson & Sons Heating', null],
  ['Huntsville Plumbing Services', null],
  ['Supply Chain Comfort Systems', null],
  ['Madison Air Conditioning', 'hvac_contractor'],
  ['Tennessee Valley Plumbing', 'plumber'],
]) {
  check(`real prospect NOT flagged as supplier: ${name}`, () =>
    assert(!isSupplierOrRetail(name, type)));
}

check('the supplier type deny-list fails open on a missing primaryType', () => {
  assert(!isSupplierOrRetail('Some Local Company', null));
  assert(!isSupplierOrRetail('Some Local Company', undefined));
});

/* ------------------------------------------------------------- lead score -- */
console.log('\nlead score');

const lead = (over) => ({
  name: 'x',
  website: null,
  review_count: null,
  distance_from_center_m: 0,
  ...over,
});

check('no website sorts ahead of a big shop that has one', () => {
  const a = lead({ name: 'No site', website: null, review_count: 3 });
  const b = lead({ name: 'Has site', website: 'https://x.example', review_count: 900 });
  eq([a, b].sort(byLeadScore).map((r) => r.name), ['No site', 'Has site']);
});

check('an empty-string website counts as no website', () => {
  const a = lead({ name: 'blank', website: '   ', review_count: 1 });
  const b = lead({ name: 'real', website: 'https://x.example', review_count: 999 });
  eq([b, a].sort(byLeadScore).map((r) => r.name), ['blank', 'real']);
});

check('within no-website, more reviews first — the established business', () => {
  const rows = [
    lead({ name: 'small', review_count: 4 }),
    lead({ name: 'big', review_count: 412 }),
    lead({ name: 'mid', review_count: 60 }),
  ];
  eq(rows.sort(byLeadScore).map((r) => r.name), ['big', 'mid', 'small']);
});

check('a NULL review count is NOT zero — it sorts below a genuine zero', () => {
  const rows = [
    lead({ name: 'unknown', review_count: null }),
    lead({ name: 'zero', review_count: 0 }),
  ];
  eq(rows.sort(byLeadScore).map((r) => r.name), ['zero', 'unknown']);
});

check('distance breaks a review tie, then name breaks everything', () => {
  const rows = [
    lead({ name: 'far', review_count: 10, distance_from_center_m: 40000 }),
    lead({ name: 'near', review_count: 10, distance_from_center_m: 900 }),
    lead({ name: 'also near', review_count: 10, distance_from_center_m: 900 }),
  ];
  eq(rows.sort(byLeadScore).map((r) => r.name), ['also near', 'near', 'far']);
});

check('the other three sorts exist and are stable', () => {
  eq(Object.keys(SORTS), ['lead', 'distance', 'reviews', 'name']);
  const rows = [
    lead({ name: 'b', review_count: 5, distance_from_center_m: 10 }),
    lead({ name: 'a', review_count: 50, distance_from_center_m: 90 }),
  ];
  eq(rows.slice().sort(SORTS.distance.compare).map((r) => r.name), ['b', 'a']);
  eq(rows.slice().sort(SORTS.reviews.compare).map((r) => r.name), ['a', 'b']);
  eq(rows.slice().sort(SORTS.name.compare).map((r) => r.name), ['a', 'b']);
});

/* ---------------------------------------------------------------- placing -- */
console.log('\nplacing candidates in the area');

check('anything past the radius is dropped — the outer tiles overshoot on purpose', () => {
  const inside = cand({ googlePlaceId: 'in', name: 'Inside', lat: 34.75, lng: -86.58 });
  const outside = cand({ googlePlaceId: 'out', name: 'Outside', lat: 35.6, lng: -86.58 });
  const placed = placeInArea([inside, outside], HUNTSVILLE, 30 * MILE);
  eq(placed.map((p) => p.name), ['Inside']);
});

check('distance from centre is computed and stored', () => {
  const placed = placeInArea(
    [cand({ googlePlaceId: 'a', lat: 34.7304, lng: -86.5861 })],
    HUNTSVILLE,
    30 * MILE
  );
  eq(placed[0].distance_from_center_m, 0);
});

check('junk flags are set at ingest, and the row is kept either way', () => {
  const placed = placeInArea(
    [
      cand({ googlePlaceId: 'a', name: 'Roto-Rooter Plumbing' }),
      cand({ googlePlaceId: 'b', name: 'Johnstone Supply' }),
      cand({ googlePlaceId: 'c', name: 'Huntsville Heating & Air' }),
    ],
    HUNTSVILLE,
    30 * MILE
  );
  eq(placed.length, 3, 'nothing is deleted — hiding is never deleting');
  eq(placed.find((p) => p.name === 'Roto-Rooter Plumbing').is_franchise, 1);
  eq(placed.find((p) => p.name === 'Johnstone Supply').is_supplier_or_retail, 1);
  eq(placed.find((p) => p.name === 'Huntsville Heating & Air').is_franchise, 0);
});

check('the no-website headline count excludes junk', () => {
  const rows = [
    { website: null, is_franchise: 0, is_supplier_or_retail: 0 },
    { website: null, is_franchise: 1, is_supplier_or_retail: 0 },
    { website: null, is_franchise: 0, is_supplier_or_retail: 1 },
    { website: 'https://x.example', is_franchise: 0, is_supplier_or_retail: 0 },
  ];
  eq(noWebsiteCount(rows), 1);
});

check('per-industry counts count a two-trade shop under both', () => {
  eq(
    countByIndustry([
      { industries: ['hvac', 'plumbing'] },
      { industries: ['plumbing'] },
    ]),
    { hvac: 1, plumbing: 2 }
  );
});

check('per-industry counts also read the stored comma column', () => {
  eq(countByIndustry([{ industries: 'hvac,plumbing' }]), { hvac: 1, plumbing: 1 });
});

check('the review distribution keeps unknowns out of the buckets', () => {
  const d = reviewDistribution([
    { review_count: 0 },
    { review_count: 7 },
    { review_count: 30 },
    { review_count: 80 },
    { review_count: 150 },
    { review_count: 900 },
    { review_count: null },
  ]);
  eq(d.buckets, { '0': 1, '1-9': 1, '10-49': 1, '50-99': 1, '100-249': 1, '250+': 1 });
  eq(d.unknown, 1);
});

/* ---------------------------------------------------------------- budget -- */
console.log('\nsubrequest budget');

check('the Huntsville pilot shape stays far under the paid ceiling', () => {
  const { industries } = resolveIndustries(['hvac', 'plumbing']);
  const perTile = searchesPerTile(industries);
  const tiles = tileCircle(HUNTSVILLE, 30 * MILE, TILE_RADIUS_M, tileBudget(perTile)).length;
  const budget = subrequestBudget(industries, tiles, perTile);
  assert(budget.total < SUBREQUEST_CEILING, `${budget.total} exceeds ${SUBREQUEST_CEILING}`);
  assert(budget.total < 250, `pilot budget drifted upward: ${budget.total}`);
});

check('every industry at 30 miles, all on text, still stays under the ceiling', () => {
  const { industries } = resolveIndustries(INDUSTRIES.map((i) => i.key));
  const perTile = searchesPerTile(industries); // pessimistic: every one on text
  const tiles = tileCircle(HUNTSVILLE, 30 * MILE, TILE_RADIUS_M, tileBudget(perTile)).length;
  const budget = subrequestBudget(industries, tiles, perTile);
  assert(budget.total < SUBREQUEST_CEILING, `${budget.total} exceeds ${SUBREQUEST_CEILING}`);
});

check('a text-mode industry costs one call per phrasing, per tile', () => {
  const { industries } = resolveIndustries(['hvac', 'plumbing']);
  const onText = searchesPerTile(industries);
  const onTypes = searchesPerTile(industries, new Map([['hvac', 'types'], ['plumbing', 'types']]));
  eq(onTypes, 2, 'types cost one call each');
  eq(onText, 3, 'HVAC on text costs two, plumbing one');
});

check('the tile budget shrinks as the per-tile cost grows, and never hits zero', () => {
  assert(tileBudget(1) <= MAX_TILES);
  assert(tileBudget(9) < tileBudget(2), 'a costlier tile must mean fewer tiles');
  assert(tileBudget(999) >= 1, 'a run must always search at least one tile');
  assert(tileBudget(2) * 2 <= MAX_TILE_SEARCHES);
  eq(tileBudget(0), 0);
});

check('the radius presets are the 10/20/30 miles the form offers', () => {
  eq(RADIUS_PRESETS_M.map((m) => Math.round(m / MILE)), [10, 20, 30]);
});

/* ----------------------------------------------------------- enrichment -- */
console.log('\nenrichment rails');

const stored = (over = {}) => ({
  id: 'r1',
  area_id: 'a1',
  google_place_id: 'p1',
  industry: 'hvac',
  industries: 'hvac',
  name: 'Acme Heating',
  phone: null,
  website: null,
  primary_type: null,
  rating: null,
  review_count: null,
  lat: 34.73,
  lng: -86.58,
  status: 'not_called',
  flagged: 0,
  notes: '',
  is_franchise: 0,
  is_supplier_or_retail: 0,
  ...over,
});

check('an exact place id match updates rather than inserting', () => {
  const { updates, inserts } = matchAreaCandidates(
    [cand({ googlePlaceId: 'p1', name: 'Acme Heating and Air' })],
    [stored()]
  );
  eq(updates.length, 1);
  eq(updates[0].matchedBy, 'place_id');
  eq(inserts.length, 0);
});

check('a row with no place id still matches on name within 150 m', () => {
  const { updates } = matchAreaCandidates(
    [cand({ name: 'Acme Heating', lat: 34.7301, lng: -86.58 })],
    [stored({ google_place_id: null })]
  );
  eq(updates.length, 1);
  eq(updates[0].matchedBy, 'name_geo');
});

check('a candidate matching TWO stored rows updates neither', () => {
  const { updates, inserts, ambiguous } = matchAreaCandidates(
    [cand({ name: 'Acme Heating', lat: 34.73, lng: -86.58 })],
    [
      stored({ id: 'r1', google_place_id: null }),
      stored({ id: 'r2', google_place_id: null, lat: 34.7301 }),
    ]
  );
  eq(updates.length, 0);
  eq(inserts.length, 0);
  eq(ambiguous.length, 1);
});

check('a genuinely new business is inserted', () => {
  const { inserts } = matchAreaCandidates(
    [cand({ googlePlaceId: 'p9', name: 'Brand New HVAC' })],
    [stored()]
  );
  eq(inserts.length, 1);
});

check('phone and website fill from NULL and are never overwritten', () => {
  const filled = areaEnrichmentPatch(
    stored(),
    cand({ phone: '(256) 555-0100', website: 'https://acme.example' })
  );
  eq(filled.phone, '(256) 555-0100');
  eq(filled.website, 'https://acme.example');

  const held = areaEnrichmentPatch(
    stored({ phone: '(256) 555-1111', website: 'https://old.example' }),
    cand({ phone: '(256) 555-2222', website: 'https://new.example' })
  );
  assert(held === null || held.phone === undefined, 'a stored phone must survive');
  assert(held === null || held.website === undefined, 'a no-website badge must not flip mid-call');
});

check('rating and review count DO refresh — staleness is why we re-check', () => {
  const patch = areaEnrichmentPatch(
    stored({ rating: 4.2, review_count: 100 }),
    cand({ rating: 4.5, reviewCount: 143 })
  );
  eq(patch.rating, 4.5);
  eq(patch.review_count, 143);
});

check('industries only ever grow', () => {
  const patch = areaEnrichmentPatch(
    stored({ industries: 'hvac' }),
    cand({ industries: ['plumbing'] })
  );
  eq(patch.industries, 'hvac,plumbing');
  const same = areaEnrichmentPatch(stored({ industries: 'hvac,plumbing' }), cand({ industries: ['hvac'] }));
  assert(same === null || same.industries === undefined, 'no shrink, and no pointless write');
});

check('a row with nothing to gain produces no write at all', () => {
  eq(areaEnrichmentPatch(stored({ rating: null, review_count: null }), cand()), null);
});

check('a newly captured primaryType can flip the supplier flag', () => {
  const patch = areaEnrichmentPatch(
    stored({ name: 'Anytown Trading Post' }),
    cand({ primaryType: 'hardware_store' })
  );
  eq(patch.primary_type, 'hardware_store');
  eq(patch.is_supplier_or_retail, 1);
});

check('protected columns are rejected, not merely omitted', () => {
  for (const column of ['status', 'flagged', 'notes', 'name', 'id', 'area_id', 'distance_from_center_m']) {
    assert(AREA_PROTECTED_COLUMNS.has(column), `${column} must be protected`);
  }
  let threw = false;
  try {
    assertAreaPatchIsSafe({ website: 'x', notes: 'wiped' });
  } catch {
    threw = true;
  }
  assert(threw, 'writing notes must throw');
  assertAreaPatchIsSafe({ website: 'x', rating: 4.1, review_count: 9, industries: 'hvac' });
});

check('the enrichment patch never names a protected column', () => {
  const patch = areaEnrichmentPatch(
    stored({ status: 'interested', flagged: 1, notes: 'Ask for Dale' }),
    cand({ phone: '(256) 555-0100', reviewCount: 88, rating: 4.9 })
  );
  assertAreaPatchIsSafe(patch);
});

check('the shared snapshot rails catch a mutated note on an area row', () => {
  const before = snapshotOf([stored({ notes: 'Ask for Dale', flagged: 1 })]);
  const after = snapshotOf([stored({ notes: '', flagged: 0 })]);
  const result = verifySnapshot(before, after);
  assert(!result.ok);
  eq(result.violations.map((v) => v.field).sort(), ['flagged', 'notes']);
});

check('the shared snapshot rails catch a deleted area row', () => {
  const result = verifySnapshot(snapshotOf([stored()]), []);
  assert(!result.ok);
  eq(result.violations[0].now, 'missing');
});

/* -------------------------------------------------------- against SQLite -- */
console.log('\nagainst real SQLite, built from the real migrations');

let areaSeq = 0;
function addArea(db, name, industries = ['hvac', 'plumbing']) {
  const id = `area-${++areaSeq}`;
  db.prepare(
    `INSERT INTO areas (id, name, center_address, center_lat, center_lng, radius_m, industries, created_at)
     VALUES (?, ?, 'Huntsville, AL', 34.73, -86.58, 48280, ?, ?)`
  ).run(id, name, JSON.stringify(industries), `2026-08-29 10:0${areaSeq}:00`);
  return id;
}

let facSeq = 0;
function addFacility(db, areaId, over = {}) {
  const f = {
    name: `Biz ${++facSeq}`,
    website: null,
    review_count: null,
    rating: null,
    distance_from_center_m: 0,
    industry: 'hvac',
    industries: 'hvac',
    is_franchise: 0,
    is_supplier_or_retail: 0,
    status: 'not_called',
    flagged: 0,
    ...over,
  };
  db.prepare(
    `INSERT INTO area_facilities
       (id, area_id, google_place_id, industry, industries, name, website, rating, review_count,
        lat, lng, distance_from_center_m, is_franchise, is_supplier_or_retail, status, flagged)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 34.73, -86.58, ?, ?, ?, ?, ?)`
  ).run(
    `fac-${facSeq}`, areaId, `place-${facSeq}`, f.industry, f.industries, f.name,
    f.website, f.rating, f.review_count, f.distance_from_center_m,
    f.is_franchise, f.is_supplier_or_retail, f.status, f.flagged
  );
  return `fac-${facSeq}`;
}

check('migration 0007 leaves routes and facilities untouched', () => {
  const db = freshDb();
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    .all()
    .map((r) => r.name)
    .filter((n) => !n.startsWith('sqlite_'));
  for (const t of ['routes', 'facilities', 'areas', 'area_facilities']) {
    assert(tables.includes(t), `missing table ${t}`);
  }
  const facilityColumns = db.prepare(`PRAGMA table_info(facilities)`).all().map((c) => c.name);
  assert(!facilityColumns.includes('rating'), 'facilities must not have gained area columns');
  assert(!facilityColumns.includes('is_supplier_or_retail'), 'facilities must stay as it was');
  db.close();
});

check('area cards lead with the usable list, and count no-website among it', () => {
  const db = freshDb();
  const id = addArea(db, 'Huntsville pilot');
  addFacility(db, id, { website: null });                       // lead
  addFacility(db, id, { website: null, status: 'voicemail' });  // lead, called
  addFacility(db, id, { website: 'https://x.example' });        // visible, has a site
  addFacility(db, id, { website: null, is_franchise: 1 });      // hidden
  addFacility(db, id, { website: null, is_supplier_or_retail: 1 }); // hidden

  const row = db.prepare(AREA_LIST_SQL).all()[0];
  eq(row.facility_count, 5, 'everything is stored');
  eq(row.visible_count, 3, 'junk is hidden, not deleted');
  eq(row.no_website_count, 2, 'a franchise with no website is not a lead');
  eq(row.called_count, 1);
  db.close();
});

check('an empty-string website is counted as no website by the SQL too', () => {
  const db = freshDb();
  const id = addArea(db, 'blank websites');
  addFacility(db, id, { website: '' });
  addFacility(db, id, { website: '   ' });
  eq(db.prepare(AREA_LIST_SQL).all()[0].no_website_count, 2);
  db.close();
});

check('an area with no facilities reads zero, and claims no leads', () => {
  // The LEFT JOIN still yields one all-NULL row here. Without the f.id guard in
  // VISIBLE, no_website_count would count that phantom as a lead.
  const db = freshDb();
  addArea(db, 'empty');
  const row = db.prepare(AREA_LIST_SQL).all()[0];
  eq(row.facility_count, 0);
  eq(row.visible_count, 0);
  eq(row.no_website_count, 0);
  eq(row.called_count, 0);
  db.close();
});

check('progress can never read "3 of 2 called"', () => {
  const db = freshDb();
  const id = addArea(db, 'hidden calls');
  addFacility(db, id, { status: 'interested' });
  addFacility(db, id, { status: 'interested', is_franchise: 1 });
  const row = db.prepare(AREA_LIST_SQL).all()[0];
  assert(row.called_count <= row.visible_count, `${row.called_count} of ${row.visible_count}`);
  eq(row.called_count, 1);
  db.close();
});

check('the SQL lead-score order matches byLeadScore, exactly', () => {
  const db = freshDb();
  const id = addArea(db, 'ordering');
  const rows = [
    { name: 'C no-site 400', website: null, review_count: 400, distance_from_center_m: 30000 },
    { name: 'A no-site 400 near', website: null, review_count: 400, distance_from_center_m: 900 },
    { name: 'D no-site unknown', website: null, review_count: null, distance_from_center_m: 100 },
    { name: 'E no-site zero', website: null, review_count: 0, distance_from_center_m: 100 },
    { name: 'B site 9000', website: 'https://x.example', review_count: 9000, distance_from_center_m: 10 },
    { name: 'F blank site 5', website: '  ', review_count: 5, distance_from_center_m: 10 },
  ];
  for (const r of rows) addFacility(db, id, r);

  const fromSql = db.prepare(AREA_FACILITIES_SQL).all(id).map((r) => r.name);
  const fromJs = rows.slice().sort(byLeadScore).map((r) => r.name);
  eq(fromSql, fromJs, 'SQL and JS disagree — the formula has drifted');
  eq(fromSql[0], 'A no-site 400 near');
  eq(fromSql[fromSql.length - 1], 'B site 9000');
  db.close();
});

check('LEAD_SCORE_ORDER_BY is the single definition both readers use', () => {
  assert(AREA_FACILITIES_SQL.includes(LEAD_SCORE_ORDER_BY.trim()));
});

check('an area UPDATE built from a patch leaves her columns untouched', () => {
  const db = freshDb();
  const id = addArea(db, 'safety');
  const facId = addFacility(db, id, { review_count: 10 });
  db.prepare(`UPDATE area_facilities SET status = ?, flagged = 1, notes = ? WHERE id = ?`)
    .run('interested', 'Owner is Dale, call back Tuesday', facId);

  const row = db.prepare('SELECT * FROM area_facilities WHERE id = ?').get(facId);
  const before = snapshotOf([row]);
  const patch = areaEnrichmentPatch(row, cand({
    phone: '(256) 555-0100',
    website: 'https://acme.example',
    reviewCount: 143,
    rating: 4.7,
    industries: ['plumbing'],
  }));
  assertAreaPatchIsSafe(patch);
  const columns = Object.keys(patch);
  db.prepare(
    `UPDATE area_facilities SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`
  ).run(...columns.map((c) => patch[c]), facId);

  const after = db.prepare('SELECT * FROM area_facilities WHERE id = ?').get(facId);
  const result = verifySnapshot(before, snapshotOf([after]));
  assert(result.ok, JSON.stringify(result.violations));
  eq(after.status, 'interested');
  eq(after.notes, 'Owner is Dale, call back Tuesday');
  eq(after.review_count, 143, 'the review count did refresh');
  eq(after.industries, 'hvac,plumbing');
  db.close();
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
