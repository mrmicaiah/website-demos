// Merge + dedupe + corridor filtering. Kept free of Worker APIs so the unit
// checks can exercise it directly.

import { haversineMeters, nearestOnRoute } from './geo.js';
import { normalizeName, isFranchise, isHomeDaycare } from './heuristics.js';

const DEDUPE_RADIUS_M = 150;

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
      distance_from_route_m: Math.round(distanceMeters),
      position_along_route_m: Math.round(positionMeters),
      is_franchise: isFranchise(f.name) ? 1 : 0,
      is_home_daycare: isHomeDaycare(f.name, f.tags) ? 1 : 0,
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
