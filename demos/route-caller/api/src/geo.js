// Corridor math: polyline decoding, route indexing, distance-to-route and
// projection-along-route. Pure functions, no Worker APIs — so test/geo.test.mjs
// can run this file directly under node.

const EARTH_RADIUS_M = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;

/** Decode a Google encoded polyline into [{lat, lng}, ...]. */
export function decodePolyline(encoded, precision = 5) {
  if (!encoded) return [];
  const factor = 10 ** precision;
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 1;
    let shift = 0;
    let b;
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 1;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / factor, lng: lng / factor });
  }
  return points;
}

/** Great-circle distance in meters. */
export function haversineMeters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Equirectangular projection to meters, scaled at `refLat`. Accurate for
 * comparing distances within a few tens of km of the reference latitude,
 * which is all the corridor math needs.
 */
export function makeProjector(refLat) {
  const kx = EARTH_RADIUS_M * Math.cos(toRad(refLat));
  return (p) => ({ x: toRad(p.lng) * kx, y: toRad(p.lat) * EARTH_RADIUS_M });
}

/** Drop points closer together than minMeters; always keeps first and last. */
export function simplifyByDistance(points, minMeters = 200) {
  if (points.length <= 2) return points.slice();
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    if (haversineMeters(out[out.length - 1], points[i]) >= minMeters) {
      out.push(points[i]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * Precompute a route index: the points, a global projection of them, and
 * cumulative great-circle distance from the start of the route.
 */
export function buildRouteIndex(points) {
  if (!points || points.length < 2) {
    throw new Error('route needs at least two points');
  }
  const refLat = (points[0].lat + points[points.length - 1].lat) / 2;
  const project = makeProjector(refLat);
  const proj = points.map(project);
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum[i] = cum[i - 1] + haversineMeters(points[i - 1], points[i]);
  }
  return {
    points,
    proj,
    cum,
    project,
    lengthMeters: cum[cum.length - 1],
  };
}

function segmentFit(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  const d2 = (p.x - cx) ** 2 + (p.y - cy) ** 2;
  return { t, d2 };
}

/**
 * Nearest point on the route to `pt`.
 * Returns { distanceMeters, positionMeters, segmentIndex }.
 *
 * Two passes: a coarse pass over every segment in the route's global
 * projection, then a refinement over the winning segment and its neighbours
 * using a projection centred on the query point (so longitude scaling is
 * right where it matters).
 */
export function nearestOnRoute(index, pt) {
  const { proj, cum } = index;
  const p = index.project(pt);

  let bestI = 0;
  let bestD2 = Infinity;
  for (let i = 0; i < proj.length - 1; i++) {
    const { d2 } = segmentFit(p, proj[i], proj[i + 1]);
    if (d2 < bestD2) {
      bestD2 = d2;
      bestI = i;
    }
  }

  const local = makeProjector(pt.lat);
  const lp = local(pt);
  const from = Math.max(0, bestI - 1);
  const to = Math.min(proj.length - 2, bestI + 1);
  let best = { d2: Infinity, t: 0, i: bestI };
  for (let i = from; i <= to; i++) {
    const fit = segmentFit(lp, local(index.points[i]), local(index.points[i + 1]));
    if (fit.d2 < best.d2) best = { ...fit, i };
  }

  const segLen = cum[best.i + 1] - cum[best.i];
  return {
    distanceMeters: Math.sqrt(best.d2),
    positionMeters: cum[best.i] + best.t * segLen,
    segmentIndex: best.i,
  };
}

/** Linear interpolation between two lat/lng points. */
function lerpPoint(a, b, t) {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

/**
 * Sample the route roughly every `intervalMeters`, always including the start
 * and end. If that would exceed `maxPoints`, the interval is widened so the
 * count fits (Workers have a hard subrequest budget per request).
 */
export function samplePointsAlong(index, intervalMeters = 8000, maxPoints = 25) {
  const total = index.lengthMeters;
  if (total === 0 || index.points.length < 2) return [index.points[0]];

  let interval = intervalMeters;
  if (total / interval + 1 > maxPoints) {
    interval = total / (maxPoints - 1);
  }

  const out = [];
  let target = 0;
  let seg = 0;
  while (target < total && out.length < maxPoints) {
    while (seg < index.cum.length - 2 && index.cum[seg + 1] < target) seg++;
    const segLen = index.cum[seg + 1] - index.cum[seg];
    const t = segLen === 0 ? 0 : (target - index.cum[seg]) / segLen;
    out.push(lerpPoint(index.points[seg], index.points[seg + 1], Math.max(0, Math.min(1, t))));
    target += interval;
  }
  const last = index.points[index.points.length - 1];
  if (out.length === 0 || haversineMeters(out[out.length - 1], last) > 1) {
    if (out.length >= maxPoints) out.pop();
    out.push(last);
  }
  return out;
}

/** Initial bearing in degrees from a to b. */
export function bearingBetween(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** The point `distanceMeters` from `p` along `bearingDeg`. */
export function destinationPoint(p, bearingDeg, distanceMeters) {
  const angular = distanceMeters / EARTH_RADIUS_M;
  const bearing = toRad(bearingDeg);
  const lat1 = toRad(p.lat);
  const lng1 = toRad(p.lng);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing)
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2)
    );
  return {
    lat: (lat2 * 180) / Math.PI,
    lng: (((lng2 * 180) / Math.PI + 540) % 360) - 180,
  };
}

/**
 * Search points that TILE the corridor, rather than one giant circle per sample.
 *
 * A single Places nearby search returns at most 20 results, so widening its
 * radius to 30 miles does not widen coverage — in a dense area it returns the
 * nearest 20 and never reaches the edge. Measured on the Decatur route at a
 * 48 km radius: all 7 searches saturated and the entire result set collapsed
 * inside 4.2 miles, worse than the 10-mile corridor it replaced.
 *
 * So the corridor is covered by a grid instead. Each along-route sample gets
 * search points offset perpendicular to the route at ±1 and ±2 lateral steps.
 * With a 16 km step and a 16 km search radius the circles overlap, and the
 * outermost ring reaches 48 km — 30 miles — from the route.
 */
export function corridorSearchPoints(index, samples, lateralStepMeters, rings) {
  const points = [];
  for (const sample of samples) {
    const { segmentIndex } = nearestOnRoute(index, sample);
    const a = index.points[segmentIndex];
    const b = index.points[Math.min(segmentIndex + 1, index.points.length - 1)];
    const heading = bearingBetween(a, b);
    for (let ring = -rings; ring <= rings; ring++) {
      if (ring === 0) {
        points.push(sample);
        continue;
      }
      const bearing = heading + (ring > 0 ? 90 : -90);
      points.push(destinationPoint(sample, bearing, Math.abs(ring) * lateralStepMeters));
    }
  }
  return points;
}
