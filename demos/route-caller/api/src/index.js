// Route Caller API — Cloudflare Worker + D1.
//
// POST   /api/routes         run the pipeline, persist, return route + facilities
// GET    /api/routes         list routes with progress counts
// GET    /api/routes/:id     one route + its facilities in drive order
// PATCH  /api/facilities/:id update status / flagged / notes

import {
  decodePolyline,
  simplifyByDistance,
  buildRouteIndex,
  samplePointsAlong,
  corridorSearchPoints,
} from './geo.js';
import { ApiError, geocode, computeRoute, searchNearby, searchAlongRoute } from './google.js';
import { fetchOverpass, endpointList } from './overpass.js';
import {
  mergeCandidates,
  placeOnRoute,
  partitionRetail,
  summarizeExcluded,
} from './pipeline.js';

// Ingest wide, filter narrow. Her decision: store the full 30-mile corridor so
// widening the view is a UI toggle rather than a re-search. Every facility keeps
// its true distance; the frontend's distance lens does the narrowing.
// 48,280 m is 30 miles and sits just inside the Places nearby radius cap of
// 50,000 m — there is no room to widen further without a different search shape.
const CORRIDOR_M = 48280; // 30 miles — what we store and filter on
// One nearby search returns at most 20 results, so the corridor is TILED with
// overlapping 16 km searches rather than covered by one 48 km circle. See
// corridorSearchPoints in geo.js for the measurement that forced this.
// Radius doubles as the lateral step, so (2 rings + 1) * radius must cover the
// corridor: 3 x 16,100 = 48,300 m, just past the 48,280 m we store.
const SEARCH_RADIUS_M = 16100;
const LATERAL_RINGS = 2; // 0, ±16.1 km, ±32.2 km -> outer edge reaches 48.3 km
const SEARCH_POINTS_PER_SAMPLE = LATERAL_RINGS * 2 + 1;
// Overpass stays narrow on purpose: at a 48 km radius its chunks take ~8 s each
// and the pipeline runs into the edge timeout. OSM facilities and playground
// signals therefore cover the inner 10 miles; Google covers the full 30.
const OSM_CORRIDOR_M = 16000;
const SAMPLE_INTERVAL_M = 8000;
const MAX_SEARCH_POINTS = 90;
const MAX_SAMPLES = Math.floor(MAX_SEARCH_POINTS / SEARCH_POINTS_PER_SAMPLE); // 18
const SEARCH_CONCURRENCY = 12; // wall time, not subrequests, is the binding limit
const STATUSES = ['not_called', 'no_answer', 'voicemail', 'interested', 'not_interested'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    const method = request.method;

    try {
      if (path === '/api/health') {
        return json({ ok: true, google_key_configured: Boolean(env.GOOGLE_MAPS_API_KEY) });
      }
      if (path === '/api/routes' && method === 'POST') return await createRoute(request, env);
      if (path === '/api/routes' && method === 'GET') return await listRoutes(env);

      const routeMatch = path.match(/^\/api\/routes\/([\w-]+)$/);
      if (routeMatch && method === 'GET') return await getRoute(env, routeMatch[1]);

      const facMatch = path.match(/^\/api\/facilities\/([\w-]+)$/);
      if (facMatch && method === 'PATCH') return await patchFacility(request, env, facMatch[1]);

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 500;
      return json({ error: err.message || 'Unexpected error' }, status);
    }
  },
};

async function createRoute(request, env) {
  const startedAt = Date.now();
  const body = await request.json().catch(() => ({}));
  const name = (body.name || '').trim();
  const startAddress = (body.start_address || '').trim();
  const endAddress = (body.end_address || '').trim();

  if (!name || !startAddress || !endAddress) {
    return json({ error: 'name, start_address and end_address are all required' }, 400);
  }
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    return json(
      { error: 'GOOGLE_MAPS_API_KEY is not set on the Worker. Run: wrangler secret put GOOGLE_MAPS_API_KEY' },
      503
    );
  }

  const start = await geocode(startAddress, key);
  const end = await geocode(endAddress, key);
  const { encodedPolyline } = await computeRoute(start, end, key);

  const points = decodePolyline(encodedPolyline);
  if (points.length < 2) throw new ApiError('Route polyline could not be decoded', 502);
  const routeIndex = buildRouteIndex(simplifyByDistance(points, 200));
  const samples = samplePointsAlong(routeIndex, SAMPLE_INTERVAL_M, MAX_SAMPLES);

  // Each nearby search is capped at 20 results by Google. With a 30-mile radius
  // that cap bites in dense areas, so the searches rank by DISTANCE and we count
  // how often they saturate — a saturated search means facilities beyond its
  // farthest returned result were not seen by that sample point.
  const searchPoints = corridorSearchPoints(
    routeIndex,
    samples,
    SEARCH_RADIUS_M,
    LATERAL_RINGS
  );

  // Searches run in bounded parallel: on a paid Workers plan the subrequest
  // ceiling is 1000, so wall time is what constrains us, not call count.
  const placesStartedAt = Date.now();
  const googleLists = [];
  let saturatedSearches = 0;
  for (let i = 0; i < searchPoints.length; i += SEARCH_CONCURRENCY) {
    const batch = searchPoints.slice(i, i + SEARCH_CONCURRENCY);
    const found = await Promise.all(
      batch.map((point) => searchNearby(point, key, SEARCH_RADIUS_M).catch(() => []))
    );
    for (const list of found) {
      if (list.length >= 20) saturatedSearches++;
      googleLists.push(list);
    }
  }
  const placesMs = Date.now() - placesStartedAt;
  console.log(
    `route "${name}": ${searchPoints.length} Places searches in ${placesMs} ms, ` +
      `(${samples.length} along x ${SEARCH_POINTS_PER_SAMPLE} lateral), ` +
      `${saturatedSearches} saturated at radius ${SEARCH_RADIUS_M} m`
  );
  try {
    googleLists.push(await searchAlongRoute(encodedPolyline, key));
  } catch {
    // best-effort extra coverage only
  }

  let osmStatus = 'ok';
  let osmResults = [];
  let playgrounds = [];
  let osmEndpoints = [];
  let osmRequests = 0;
  let osmErrors = {};
  const osmStartedAt = Date.now();
  try {
    const overpass = await fetchOverpass(samples, OSM_CORRIDOR_M, {
      endpoints: endpointList(env.OVERPASS_URL),
    });
    osmResults = overpass.facilities;
    playgrounds = overpass.playgrounds;
    osmEndpoints = overpass.endpointsUsed;
    osmRequests = overpass.requests;
    osmErrors = overpass.errors;
    if (!overpass.chunksOk) {
      // Google-only fallback: facilities still found, but no playground signal.
      osmStatus = `unavailable: ${String(overpass.lastError || 'no chunks served').slice(0, 120)}`;
    } else if (overpass.chunksOk < overpass.chunksTotal) {
      // Some of the corridor was covered; say so rather than claiming 'ok'.
      osmStatus = `partial: ${overpass.chunksOk} of ${overpass.chunksTotal} chunks`;
    }
    console.log(
      `route "${name}": overpass ${overpass.chunksOk}/${overpass.chunksTotal} chunks in ` +
        `${overpass.requests} requests; served by ${overpass.endpointsUsed.join(', ') || 'nothing'}; ` +
        `errors ${JSON.stringify(overpass.errors)}`
    );
  } catch (err) {
    osmStatus = `unavailable: ${String(err.message).slice(0, 120)}`;
  }

  // Drop big-box retail Google mistyped as child care, before the merge so an OSM
  // row can't resurrect one. OSM candidates carry no primaryType and pass through.
  const { kept, excluded } = partitionRetail(googleLists.flat());
  const excludedSummary = summarizeExcluded(excluded, routeIndex, CORRIDOR_M);
  if (excluded.length) {
    console.log(
      `route "${name}": excluded ${excludedSummary.effective} facilit(ies) ` +
        `from ${excludedSummary.raw} retail result(s):`,
      excluded.map((r) => `${r.name} (${r.primaryType})`).join(', ')
    );
  }

  const osmMs = Date.now() - osmStartedAt;

  const facilities = placeOnRoute(
    mergeCandidates([kept, osmResults]),
    routeIndex,
    CORRIDOR_M,
    playgrounds
  );

  const routeId = crypto.randomUUID();
  const statements = [
    env.DB.prepare(
      `INSERT INTO routes (id, name, start_address, end_address, polyline, osm_status, corridor_m)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      routeId, name, start.formatted || startAddress, end.formatted || endAddress,
      encodedPolyline, osmStatus, CORRIDOR_M
    ),
  ];

  const rows = facilities.map((f) => ({ ...f, id: crypto.randomUUID(), route_id: routeId }));
  for (const f of rows) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO facilities
           (id, route_id, name, address, city, zip, phone, website, lat, lng,
            source, primary_type, distance_from_route_m, position_along_route_m,
            is_franchise, is_home_daycare, is_school_program,
            playground_nearby, playground_unlikely)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        f.id, routeId, f.name, f.address, f.city, f.zip, f.phone, f.website || null,
        f.lat, f.lng, f.source, f.primaryType || null,
        f.distance_from_route_m, f.position_along_route_m,
        f.is_franchise, f.is_home_daycare, f.is_school_program,
        f.is_playground_nearby, f.is_playground_unlikely
      )
    );
  }
  // D1 batches are chunked so a dense route doesn't overrun the batch limit.
  for (let i = 0; i < statements.length; i += 50) {
    await env.DB.batch(statements.slice(i, i + 50));
  }

  const route = await selectRoute(env, routeId);
  return json(
    {
      route,
      facilities: await selectFacilities(env, routeId),
      meta: {
        // Entries actually kept off the call list, and the raw candidate count
        // behind it — one store can be returned by several corridor searches.
        excluded_retail: excludedSummary.effective,
        excluded_retail_raw: excludedSummary.raw,
        excluded_types: excludedSummary.types,
        osm_endpoints: osmEndpoints,
        osm_requests: osmRequests,
        osm_errors: osmErrors,
        corridor_m: CORRIDOR_M,
        places_searches: searchPoints.length,
        places_saturated: saturatedSearches,
        places_ms: placesMs,
        osm_ms: osmMs,
        osm_corridor_m: OSM_CORRIDOR_M,
        elapsed_ms: Date.now() - startedAt,
      },
    },
    201
  );
}

async function listRoutes(env) {
  const { results } = await env.DB.prepare(
    `SELECT r.*,
            COUNT(f.id) AS facility_count,
            SUM(CASE WHEN f.status != 'not_called' THEN 1 ELSE 0 END) AS called_count,
            SUM(f.flagged) AS flagged_count
       FROM routes r
       LEFT JOIN facilities f ON f.route_id = r.id
      GROUP BY r.id
      ORDER BY r.created_at DESC`
  ).all();
  return json({ routes: results || [] });
}

async function getRoute(env, id) {
  const route = await selectRoute(env, id);
  if (!route) return json({ error: 'Route not found' }, 404);
  return json({ route, facilities: await selectFacilities(env, id) });
}

async function patchFacility(request, env, id) {
  const body = await request.json().catch(() => ({}));
  const sets = [];
  const values = [];

  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) {
      return json({ error: `status must be one of: ${STATUSES.join(', ')}` }, 400);
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
  if (!sets.length) return json({ error: 'Nothing to update' }, 400);

  sets.push("updated_at = datetime('now')");
  const row = await env.DB.prepare(
    `UPDATE facilities SET ${sets.join(', ')} WHERE id = ? RETURNING *`
  )
    .bind(...values, id)
    .first();

  if (!row) return json({ error: 'Facility not found' }, 404);
  return json({ facility: row });
}

const selectRoute = (env, id) =>
  env.DB.prepare('SELECT * FROM routes WHERE id = ?').bind(id).first();

async function selectFacilities(env, routeId) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM facilities WHERE route_id = ?
      ORDER BY position_along_route_m ASC, distance_from_route_m ASC, name ASC`
  )
    .bind(routeId)
    .all();
  return results || [];
}
