// The /api/areas endpoints. Additive to this Worker: they share its key, its D1
// binding and its shared modules, and they touch neither `routes` nor
// `facilities`.
//
//   GET    /api/industries              the preset menu, so the UI has no copy
//   POST   /api/areas                   geocode, tile, search, classify, persist
//   GET    /api/areas                   areas with their counts
//   GET    /api/areas/:id               one area + its list in lead-score order
//   POST   /api/areas/:id/enrich        re-check in place; never touches her work
//   PATCH  /api/area-facilities/:id     status / flagged / notes

import { ApiError, geocode } from '../google.js';
import { TILE_RADIUS_M, tileCircle } from '../shared/tiling.js';
import { INDUSTRIES, resolveIndustries, DEFAULT_INDUSTRY_KEYS } from './industries.js';
import {
  searchNearbyTypes,
  searchTextInCircle,
  searchTextInArea,
  toAreaCandidate,
  UnsupportedTypes,
} from './google.js';
import {
  mergeAreaCandidates,
  placeInArea,
  countByIndustry,
  reviewDistribution,
  noWebsiteCount,
} from './pipeline.js';
import { AREA_LIST_SQL, AREA_FACILITIES_SQL, AGENDA_SQL } from './queries.js';
import { AREA_STATUSES, RETRYABLE_STATUSES, isLocalDate, isLocalDateTime } from './statuses.js';
import {
  matchAreaCandidates,
  areaEnrichmentPatch,
  assertAreaPatchIsSafe,
  snapshotOf,
  verifySnapshot,
} from './enrich.js';

export const RADIUS_PRESETS_M = [16093, 32187, 48280]; // 10 / 20 / 30 miles
export const MIN_RADIUS_M = 1609;
export const MAX_RADIUS_M = 80467; // 50 miles — past this, tile counts stop being sane

// Tiles are capped so a seven-industry pull cannot quietly become a 400-search
// request. The cap is per-run and shared across the selected industries, and it
// is REPORTED rather than applied silently — a capped area is under-covered at
// its edge and the caller deserves to know.
export const MAX_TILES = 60;
export const MAX_TILE_SEARCHES = 240;
export const SEARCH_CONCURRENCY = 12;
// The paid Workers ceiling. Route ingest sits at ~114 of this; the budget test
// asserts the worst-case area stays under it too.
export const SUBREQUEST_CEILING = 1000;

/**
 * How many searches one tile costs, given the industries selected and how each
 * of them resolved. An industry on types costs one call per tile; an industry on
 * text costs one call PER PHRASING, because text search matches profile text and
 * one phrase is not coverage.
 *
 * `modes` is optional: without it this assumes the pessimistic (text) case, which
 * is what the budget assertion wants.
 */
export function searchesPerTile(industries, modes = null) {
  return industries.reduce((sum, i) => {
    const onTypes = modes ? modes.get(i.key) === 'types' : false;
    return sum + (onTypes ? 1 : Math.max(1, i.tileQueries.length));
  }, 0);
}

/** How many tiles this run may use, given what each tile costs. */
export function tileBudget(perTile) {
  if (perTile <= 0) return 0;
  return Math.max(1, Math.min(MAX_TILES, Math.floor(MAX_TILE_SEARCHES / perTile)));
}

/**
 * Every Google subrequest a run will make, counted before it makes them.
 * 1 geocode + 1 type probe per industry that has types + tiles x per-tile cost
 * + the broad text sweeps. Asserted against SUBREQUEST_CEILING by the tests.
 */
export function subrequestBudget(industries, tileCount, perTile = null) {
  const probes = industries.filter((i) => i.types.length).length;
  const sweeps = industries.reduce((sum, i) => sum + i.textQueries.length, 0);
  const cost = perTile == null ? searchesPerTile(industries) : perTile;
  return {
    geocode: 1,
    probes,
    per_tile: cost,
    tiles: tileCount * cost,
    sweeps,
    total: 1 + probes + tileCount * cost + sweeps,
  };
}

async function inBatches(items, size, run) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(run))));
  }
  return out;
}

/**
 * Run the whole search phase for an area and return raw candidate lists.
 *
 * The type probe is the interesting part. Places (New) renames and adds Table A
 * types, and one unknown type 400s the entire searchNearby call — so an
 * industry's `types` are tried ONCE at the centre before tiling. If they are
 * rejected, that industry falls back to its `tileQuery` text search for the whole
 * run. A stale type name therefore costs one wasted call, never an empty area.
 */
async function searchArea(center, radiusMeters, industries, key) {
  const lists = [];
  const typesRejected = [];
  let leanResponses = 0;
  let saturated = 0;
  let calls = 0;
  // Counted and reported. A tile search that fails is a hole in the area, and
  // the first Huntsville pilot lost every HVAC tile to a silent 400.
  const tileFailures = [];

  const modes = new Map();
  for (const industry of industries) {
    if (!industry.types.length) {
      modes.set(industry.key, 'text');
      continue;
    }
    calls++;
    try {
      const probe = await searchNearbyTypes(center, industry.types, key, TILE_RADIUS_M);
      if (probe.leanUsed) leanResponses++;
      modes.set(industry.key, 'types');
      lists.push(probe.places.map((p) => toAreaCandidate(p, industry.key)));
    } catch (err) {
      if (err instanceof UnsupportedTypes) {
        typesRejected.push({ industry: industry.key, types: industry.types });
        modes.set(industry.key, 'text');
      } else {
        modes.set(industry.key, 'types'); // a transient failure, not a bad type
      }
    }
  }

  // Tiles are laid out only once the modes are known, so a run that falls back
  // to text (which costs more calls per tile) automatically gets fewer tiles
  // rather than blowing the budget.
  const perTile = searchesPerTile(industries, modes);
  const tiles = tileCircle(center, radiusMeters, TILE_RADIUS_M, tileBudget(perTile));

  const jobs = [];
  for (const industry of industries) {
    const queries = modes.get(industry.key) === 'types' ? [null] : industry.tileQueries;
    for (const tile of tiles) {
      for (const query of queries) jobs.push({ industry, tile, query });
    }
  }
  calls += jobs.length;
  const tileResults = await inBatches(jobs, SEARCH_CONCURRENCY, async ({ industry, tile, query }) => {
    try {
      const result =
        query === null
          ? await searchNearbyTypes(tile, industry.types, key, TILE_RADIUS_M)
          : await searchTextInCircle(tile, query, key, TILE_RADIUS_M);
      return { industry, result };
    } catch (err) {
      tileFailures.push({ industry: industry.key, error: String(err.message).slice(0, 160) });
      return null;
    }
  });
  for (const entry of tileResults) {
    if (!entry) continue;
    if (entry.result.leanUsed) leanResponses++;
    if (entry.result.places.length >= 20) saturated++;
    lists.push(entry.result.places.map((p) => toAreaCandidate(p, entry.industry.key)));
  }

  // Broad sweeps: once per area per query, not per tile. Best-effort.
  const sweeps = [];
  for (const industry of industries) {
    for (const query of industry.textQueries) sweeps.push({ industry, query });
  }
  calls += sweeps.length;
  const sweepResults = await inBatches(sweeps, SEARCH_CONCURRENCY, async ({ industry, query }) => {
    try {
      const result = await searchTextInArea(center, query, key, radiusMeters);
      return { industry, result };
    } catch {
      return null;
    }
  });
  for (const entry of sweepResults) {
    if (!entry) continue;
    if (entry.result.leanUsed) leanResponses++;
    lists.push(entry.result.places.map((p) => toAreaCandidate(p, entry.industry.key)));
  }

  return {
    lists, tiles, typesRejected, leanResponses, saturated, calls, modes, perTile,
    tileFailures,
  };
}

const industriesColumn = (row) => (row.industries || [row.industry]).join(',');

function insertStatement(env, areaId, f) {
  return env.DB.prepare(
    `INSERT INTO area_facilities
       (id, area_id, google_place_id, industry, industries, name, address, city, zip,
        phone, website, lat, lng, rating, review_count, primary_type,
        distance_from_center_m, is_franchise, is_supplier_or_retail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    f.id, areaId, f.googlePlaceId || null, f.industry, industriesColumn(f),
    f.name, f.address || null, f.city || null, f.zip || null,
    f.phone || null, f.website || null, f.lat, f.lng,
    f.rating ?? null, f.reviewCount ?? null, f.primaryType || null,
    f.distance_from_center_m, f.is_franchise, f.is_supplier_or_retail
  );
}

export async function createArea(request, env, json) {
  const startedAt = Date.now();
  const body = await request.json().catch(() => ({}));
  const name = (body.name || '').trim();
  const centerAddress = (body.center_address || '').trim();
  const radiusM = Number(body.radius_m) || RADIUS_PRESETS_M[RADIUS_PRESETS_M.length - 1];
  const requested = Array.isArray(body.industries) && body.industries.length
    ? body.industries
    : DEFAULT_INDUSTRY_KEYS;

  if (!name || !centerAddress) {
    return json({ error: 'name and center_address are both required' }, 400);
  }
  if (radiusM < MIN_RADIUS_M || radiusM > MAX_RADIUS_M) {
    return json({ error: `radius_m must be between ${MIN_RADIUS_M} and ${MAX_RADIUS_M}` }, 400);
  }
  const { industries, unknown } = resolveIndustries(requested);
  if (unknown.length) return json({ error: `Unknown industries: ${unknown.join(', ')}` }, 400);
  if (!industries.length) return json({ error: 'Pick at least one industry' }, 400);

  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    return json(
      { error: 'GOOGLE_MAPS_API_KEY is not set on the Worker. Run: wrangler secret put GOOGLE_MAPS_API_KEY' },
      503
    );
  }

  const center = await geocode(centerAddress, key);
  const searchStartedAt = Date.now();
  const search = await searchArea(center, radiusM, industries, key);
  const searchMs = Date.now() - searchStartedAt;

  const merged = mergeAreaCandidates(search.lists);
  const placed = placeInArea(merged, center, radiusM);
  const rows = placed.map((f) => ({ ...f, id: crypto.randomUUID() }));

  const areaId = crypto.randomUUID();
  const statements = [
    env.DB.prepare(
      `INSERT INTO areas (id, name, center_address, center_lat, center_lng, radius_m, industries, osm_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      areaId, name, center.formatted || centerAddress, center.lat, center.lng,
      radiusM, JSON.stringify(industries.map((i) => i.key)),
      // Overpass is deliberately not run for areas — see CONTEXT.md. The column
      // exists because the schema is a sibling of routes'; 'skipped' says so.
      'skipped'
    ),
  ];
  for (const f of rows) statements.push(insertStatement(env, areaId, f));
  for (let i = 0; i < statements.length; i += 50) {
    await env.DB.batch(statements.slice(i, i + 50));
  }

  const budget = subrequestBudget(industries, search.tiles.length, search.perTile);
  return json(
    {
      area: await selectArea(env, areaId),
      facilities: await selectAreaFacilities(env, areaId),
      meta: {
        raw_results: search.lists.reduce((n, l) => n + l.length, 0),
        after_dedupe: merged.length,
        stored: rows.length,
        dropped_outside_radius: merged.length - rows.length,
        no_website: noWebsiteCount(rows),
        per_industry: countByIndustry(rows),
        reviews: reviewDistribution(rows),
        franchises: rows.filter((r) => r.is_franchise).length,
        suppliers: rows.filter((r) => r.is_supplier_or_retail).length,
        franchise_samples: rows.filter((r) => r.is_franchise).slice(0, 12).map((r) => r.name),
        supplier_samples: rows.filter((r) => r.is_supplier_or_retail).slice(0, 12).map((r) => r.name),
        tiles: search.tiles.length,
        tiles_capped: search.tiles.length >= tileBudget(search.perTile),
        industry_search_mode: Object.fromEntries(search.modes),
        places_calls: search.calls,
        places_saturated: search.saturated,
        tile_failures: search.tileFailures.length,
        tile_failure_sample: search.tileFailures.slice(0, 3),
        lean_mask_responses: search.leanResponses,
        types_rejected: search.typesRejected,
        subrequest_budget: budget,
        radius_m: radiusM,
        search_ms: searchMs,
        elapsed_ms: Date.now() - startedAt,
      },
    },
    201
  );
}

/** Re-check an area in place. Safe on an area she is mid-way through calling. */
export async function enrichArea(env, areaId, json) {
  const startedAt = Date.now();
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key) return json({ error: 'GOOGLE_MAPS_API_KEY is not set on the Worker.' }, 503);

  const area = await selectArea(env, areaId);
  if (!area) return json({ error: 'Area not found' }, 404);
  const existing = await selectAreaFacilities(env, areaId);
  const before = snapshotOf(existing);

  let keys;
  try {
    keys = JSON.parse(area.industries);
  } catch {
    keys = DEFAULT_INDUSTRY_KEYS;
  }
  const { industries } = resolveIndustries(keys);
  if (!industries.length) return json({ error: 'This area has no known industries' }, 400);

  const center = { lat: area.center_lat, lng: area.center_lng };
  if (center.lat == null || center.lng == null) {
    return json({ error: 'This area has no stored centre to re-search from' }, 400);
  }

  const search = await searchArea(center, area.radius_m, industries, key);
  const candidates = placeInArea(mergeAreaCandidates(search.lists), center, area.radius_m);
  const { updates, inserts, ambiguous } = matchAreaCandidates(candidates, existing);

  const filled = { websites: 0, phones: 0, primary_types: 0, ratings: 0, industries: 0 };
  const failures = [];
  const statements = [];

  for (const { row, candidate } of updates) {
    const patch = areaEnrichmentPatch(row, candidate);
    if (!patch) continue;
    assertAreaPatchIsSafe(patch);
    if (patch.website) filled.websites++;
    if (patch.phone) filled.phones++;
    if (patch.primary_type) filled.primary_types++;
    if (patch.review_count !== undefined || patch.rating !== undefined) filled.ratings++;
    if (patch.industries) filled.industries++;

    const columns = Object.keys(patch);
    statements.push({
      id: row.id,
      statement: env.DB.prepare(
        `UPDATE area_facilities SET ${columns.map((c) => `${c} = ?`).join(', ')},
           updated_at = datetime('now') WHERE id = ?`
      ).bind(...columns.map((c) => patch[c]), row.id),
    });
  }

  const inserted = inserts.map((f) => ({ ...f, id: crypto.randomUUID() }));
  for (const f of inserted) {
    statements.push({ id: f.id, statement: insertStatement(env, areaId, f) });
  }

  for (let i = 0; i < statements.length; i += 50) {
    const chunk = statements.slice(i, i + 50);
    try {
      await env.DB.batch(chunk.map((s) => s.statement));
    } catch {
      for (const item of chunk) {
        try {
          await item.statement.run();
        } catch (err) {
          failures.push({ id: item.id, error: String(err.message).slice(0, 160) });
        }
      }
    }
  }

  const after = snapshotOf(await selectAreaFacilities(env, areaId));
  const verification = verifySnapshot(before, after);
  if (!verification.ok) {
    console.error(
      `AREA ENRICH SNAPSHOT VIOLATION on area ${areaId}:`,
      JSON.stringify(verification.violations).slice(0, 600)
    );
  }

  return json({
    area: await selectArea(env, areaId),
    facilities: await selectAreaFacilities(env, areaId),
    enrichment: {
      rows_before: existing.length,
      rows_updated: statements.length - inserted.length - failures.length,
      rows_inserted: inserted.length,
      fields_filled: filled,
      ambiguous_matches: ambiguous.map((a) => ({
        candidate: a.candidate.name,
        matches: a.rows.map((r) => r.name),
      })),
      row_failures: failures,
      snapshot_verified: verification.ok,
      snapshot_violations: verification.violations,
      types_rejected: search.typesRejected,
      candidates_seen: candidates.length,
      tile_failures: search.tileFailures.length,
      elapsed_ms: Date.now() - startedAt,
    },
  });
}

export async function listAreas(env, json) {
  const { results } = await env.DB.prepare(AREA_LIST_SQL).all();
  return json({ areas: results || [] });
}

export async function getArea(env, id, json) {
  const area = await selectArea(env, id);
  if (!area) return json({ error: 'Area not found' }, 404);
  return json({ area, facilities: await selectAreaFacilities(env, id) });
}

export function listIndustries(json) {
  return json({
    industries: INDUSTRIES.map(({ key, label, defaultOn }) => ({ key, label, defaultOn })),
    radius_presets_m: RADIUS_PRESETS_M,
  });
}

/**
 * Update one business's pipeline state.
 *
 * Two rules are enforced HERE and not only in the UI, because they are what
 * makes the pipeline binary rather than a set of loose fields:
 *
 * 1. `meeting_set` REQUIRES a `meeting_at`. A booked brainstorm with no time on
 *    it is exactly the gray zone this product refuses to have — it would sit in
 *    the pipeline looking like progress while being nothing. The row must
 *    already carry a time or the same request must supply one.
 * 2. Neither date is ever cleared by a status change. Moving off `meeting_set`
 *    keeps `meeting_at` stored and inert; the agenda query simply stops
 *    surfacing it. Only an explicit `null` from him clears a date.
 */
export async function patchAreaFacility(request, env, id, json) {
  const body = await request.json().catch(() => ({}));
  const existing = await env.DB.prepare(
    'SELECT status, meeting_at, follow_up_date FROM area_facilities WHERE id = ?'
  )
    .bind(id)
    .first();
  if (!existing) return json({ error: 'Business not found' }, 404);

  const sets = [];
  const values = [];

  if (body.status !== undefined) {
    if (!AREA_STATUSES.includes(body.status)) {
      return json({ error: `status must be one of: ${AREA_STATUSES.join(', ')}` }, 400);
    }
    sets.push('status = ?');
    values.push(body.status);
  }
  if (body.flagged !== undefined) {
    sets.push('flagged = ?');
    values.push(body.flagged ? 1 : 0);
  }
  if (body.notes !== undefined) {
    sets.push('notes = ?');
    values.push(String(body.notes).slice(0, 4000));
  }
  if (body.meeting_at !== undefined) {
    if (body.meeting_at !== null && !isLocalDateTime(body.meeting_at)) {
      return json({ error: 'meeting_at must be local wall-clock YYYY-MM-DDTHH:MM, or null' }, 400);
    }
    sets.push('meeting_at = ?');
    values.push(body.meeting_at);
  }
  if (body.follow_up_date !== undefined) {
    if (body.follow_up_date !== null && !isLocalDate(body.follow_up_date)) {
      return json({ error: 'follow_up_date must be local YYYY-MM-DD, or null' }, 400);
    }
    sets.push('follow_up_date = ?');
    values.push(body.follow_up_date);
  }
  if (!sets.length) return json({ error: 'Nothing to update' }, 400);

  const nextStatus = body.status ?? existing.status;
  const nextMeetingAt =
    body.meeting_at !== undefined ? body.meeting_at : existing.meeting_at;
  if (nextStatus === 'meeting_set' && !isLocalDateTime(nextMeetingAt)) {
    return json(
      { error: 'meeting_set requires meeting_at — a booked brainstorm needs a time on it' },
      400
    );
  }

  sets.push("updated_at = datetime('now')");
  const row = await env.DB.prepare(
    `UPDATE area_facilities SET ${sets.join(', ')} WHERE id = ? RETURNING *`
  )
    .bind(...values, id)
    .first();

  if (!row) return json({ error: 'Business not found' }, 404);
  return json({ facility: row });
}

/**
 * Everything the Today panel needs, across every area — the same rows the
 * in-area panel filters down by `area_id`, so both are one component over one
 * query.
 *
 * No date comparison happens server-side: the strings are local wall-clock and
 * the Worker does not know his timezone, so the browser decides what today is.
 */
export async function getAgenda(env, json) {
  const { results } = await env.DB.prepare(AGENDA_SQL).all();
  return json({ rows: results || [], statuses: AREA_STATUSES, retryable: RETRYABLE_STATUSES });
}

const selectArea = (env, id) =>
  env.DB.prepare('SELECT * FROM areas WHERE id = ?').bind(id).first();

async function selectAreaFacilities(env, areaId) {
  const { results } = await env.DB.prepare(AREA_FACILITIES_SQL).bind(areaId).all();
  return results || [];
}

export { ApiError };
