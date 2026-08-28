// Route Caller API — Cloudflare Worker + D1.
//
// POST   /api/routes         run the pipeline, persist, return route + facilities
// GET    /api/routes         list routes with progress counts
// GET    /api/routes/:id     one route + its facilities in drive order
// PATCH  /api/facilities/:id update status / flagged / notes

import { decodePolyline, simplifyByDistance, buildRouteIndex, samplePointsAlong } from './geo.js';
import { ApiError, geocode, computeRoute, searchNearby, searchAlongRoute } from './google.js';
import { fetchOverpass } from './overpass.js';
import {
  mergeCandidates,
  placeOnRoute,
  partitionRetail,
  summarizeExcluded,
} from './pipeline.js';

const CORRIDOR_M = 16000; // 10 miles
const SAMPLE_INTERVAL_M = 8000;
const MAX_SAMPLES = 25; // keeps us inside the Worker subrequest budget
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

  const googleLists = [];
  for (const point of samples) {
    googleLists.push(await searchNearby(point, key, CORRIDOR_M));
  }
  try {
    googleLists.push(await searchAlongRoute(encodedPolyline, key));
  } catch {
    // best-effort extra coverage only
  }

  let osmStatus = 'ok';
  let osmResults = [];
  try {
    osmResults = await fetchOverpass(samples, CORRIDOR_M);
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

  const facilities = placeOnRoute(
    mergeCandidates([kept, osmResults]),
    routeIndex,
    CORRIDOR_M
  );

  const routeId = crypto.randomUUID();
  const statements = [
    env.DB.prepare(
      `INSERT INTO routes (id, name, start_address, end_address, polyline, osm_status)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(routeId, name, start.formatted || startAddress, end.formatted || endAddress, encodedPolyline, osmStatus),
  ];

  const rows = facilities.map((f) => ({ ...f, id: crypto.randomUUID(), route_id: routeId }));
  for (const f of rows) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO facilities
           (id, route_id, name, address, city, zip, phone, lat, lng, source, primary_type,
            distance_from_route_m, position_along_route_m, is_franchise, is_home_daycare)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        f.id, routeId, f.name, f.address, f.city, f.zip, f.phone, f.lat, f.lng, f.source,
        f.primaryType || null,
        f.distance_from_route_m, f.position_along_route_m, f.is_franchise, f.is_home_daycare
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
