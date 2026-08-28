// Merge + dedupe + corridor filtering. Kept free of Worker APIs so the unit
// checks can exercise it directly.

import { haversineMeters, nearestOnRoute } from './geo.js';
import { normalizeName, isFranchise, isHomeDaycare, isSchoolProgram } from './heuristics.js';

const DEDUPE_RADIUS_M = 150;

/**
 * Google occasionally types a big-box store as a child care result (a Target came
 * back on the Decatur route, presumably from an in-store care listing).
 *
 * This is deliberately a DENY-list, never an allow-list, and it reads only
 * `primaryType` — never the name. Legitimate child care runs inside churches,
 * community centres, YMCAs and schools, so anything ambiguous is kept. A row with
 * no primaryType at all is kept too: the filter fails open.
 */
const RETAIL_TYPES = new Set([
  'department_store',
  'discount_store',
  'supermarket',
  'grocery_store',
  'grocery_or_supermarket',
  'shopping_mall',
  'convenience_store',
  'clothing_store',
  'shoe_store',
  'jewelry_store',
  'furniture_store',
  'home_improvement_store',
  'hardware_store',
  'electronics_store',
  'book_store',
  'pet_store',
  'sporting_goods_store',
  'liquor_store',
  'warehouse_store',
  'wholesaler',
  'gas_station',
  'car_dealer',
  'car_repair',
  'pharmacy',
  'drugstore',
  'bank',
]);

export function isRetailNonChildcare(candidate) {
  return RETAIL_TYPES.has(candidate?.primaryType);
}

/**
 * Split candidates into the ones we keep and the retail rows we drop, so the
 * exclusions can be reported rather than disappearing silently.
 */
export function partitionRetail(candidates) {
  const kept = [];
  const excluded = [];
  for (const candidate of candidates) {
    (isRetailNonChildcare(candidate) ? excluded : kept).push(candidate);
  }
  return { kept, excluded };
}

/**
 * Same normalized name within 150 m = same facility. The record with a phone
 * number wins; `source` becomes 'both' when Google and OSM agree on a place.
 */
export function mergeCandidates(lists) {
  const merged = [];
  const byName = new Map();

  for (const candidate of lists.flat()) {
    if (!candidate || candidate.lat == null || candidate.lng == null || !candidate.name) {
      continue;
    }
    const key = normalizeName(candidate.name);
    const bucket = byName.get(key) || [];
    const twin = bucket.find(
      (existing) => haversineMeters(existing, candidate) <= DEDUPE_RADIUS_M
    );
    if (twin) {
      absorb(twin, candidate);
    } else {
      const record = { ...candidate };
      bucket.push(record);
      byName.set(key, bucket);
      merged.push(record);
    }
  }
  return merged;
}

function absorb(target, incoming) {
  if (!target.phone && incoming.phone) {
    target.phone = incoming.phone;
    target.lat = incoming.lat;
    target.lng = incoming.lng;
    target.name = incoming.name;
  }
  target.address = target.address || incoming.address;
  target.city = target.city || incoming.city;
  target.zip = target.zip || incoming.zip;
  target.primaryType = target.primaryType || incoming.primaryType || null;
  target.tags = { ...(incoming.tags || {}), ...(target.tags || {}) };
  if (target.source !== incoming.source) target.source = 'both';
}

/**
 * Attach corridor geometry and flags, drop anything further than
 * `maxDistanceMeters` from the polyline, and return in drive order.
 */
export function placeOnRoute(facilities, routeIndex, maxDistanceMeters = 16000) {
  const placed = [];
  for (const f of facilities) {
    const { distanceMeters, positionMeters } = nearestOnRoute(routeIndex, f);
    if (distanceMeters > maxDistanceMeters) continue;
    placed.push({
      ...f,
      primaryType: f.primaryType || null,
      distance_from_route_m: Math.round(distanceMeters),
      position_along_route_m: Math.round(positionMeters),
      is_franchise: isFranchise(f.name) ? 1 : 0,
      is_home_daycare: isHomeDaycare(f.name, f.tags) ? 1 : 0,
      is_school_program: isSchoolProgram(f.name, f.tags, f.primaryType) ? 1 : 0,
    });
  }
  placed.sort(byDriveOrder);
  return placed;
}

/**
 * Drive order. Facilities beside or behind an endpoint all clamp to the same
 * position, so distance off route breaks the tie (closest first) and the name
 * settles the rest — otherwise the order of a cluster is arbitrary.
 */
export function byDriveOrder(a, b) {
  return (
    (a.position_along_route_m || 0) - (b.position_along_route_m || 0) ||
    (a.distance_from_route_m || 0) - (b.distance_from_route_m || 0) ||
    String(a.name || '').localeCompare(String(b.name || ''))
  );
}

/**
 * Describe what the retail deny-list removed, in both the honest senses:
 *
 * - `raw` counts candidates as Google returned them, so one store found by five
 *   overlapping sample-point searches counts five times.
 * - `effective` runs the excluded rows through the same dedupe and corridor
 *   filter the kept rows go through, so it is the number of entries the caller
 *   would actually have seen on the list. This is the number that matters.
 */
export function summarizeExcluded(excluded, routeIndex, maxDistanceMeters = 16000) {
  const types = {};
  for (const row of excluded) {
    const key = row.primaryType || 'unknown';
    types[key] = (types[key] || 0) + 1;
  }
  const effective = placeOnRoute(
    mergeCandidates([excluded]),
    routeIndex,
    maxDistanceMeters
  ).length;
  return { raw: excluded.length, effective, types };
}
