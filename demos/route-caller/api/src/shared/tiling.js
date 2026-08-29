// Tiling: the most expensive lesson in this repository, in one place.
//
// A single Places nearby search returns at most 20 results, so a WIDE SEARCH
// RADIUS IS NOT WIDE COVERAGE. Measured on the Decatur route: raising the
// radius to 48 km made every search saturate and collapsed the whole result set
// inside 4.2 miles — worse than the 10-mile corridor it replaced. Coverage
// comes from many overlapping small searches, never from one big circle.
//
// `TILE_RADIUS_M` is that small search. The route pipeline lays these out along
// a corridor (geo.js `corridorSearchPoints`); the area pipeline lays them out
// over a disc (`tileCircle` here). Both use the same radius, and the step
// equals the radius so the circles overlap generously.

import { destinationPoint, haversineMeters } from '../geo.js';

/** One search circle. 16.1 km, so three of them span 30 miles. */
export const TILE_RADIUS_M = 16100;

/**
 * Search points covering a disc of `radiusMeters` around `center`.
 *
 * A square lattice at `stepMeters` spacing, kept where the lattice point is
 * within one step of the disc — that outer ring is what makes the EDGE of the
 * area covered rather than merely approached. With step == radius the circles
 * overlap by half, so there is no seam between tiles.
 *
 * Returned nearest-first. If `maxTiles` bites, the tiles that are dropped are
 * therefore the farthest ones — the same principle as `rankPreference:
 * DISTANCE` on an individual search. Losing the edge of the area is survivable;
 * losing its middle is not.
 */
export function tileCircle(center, radiusMeters, stepMeters = TILE_RADIUS_M, maxTiles = Infinity) {
  const reach = radiusMeters + stepMeters;
  const rings = Math.ceil(reach / stepMeters);
  const tiles = [];

  for (let iy = -rings; iy <= rings; iy++) {
    for (let ix = -rings; ix <= rings; ix++) {
      const dy = iy * stepMeters;
      const dx = ix * stepMeters;
      const offset = Math.hypot(dx, dy);
      if (offset > reach) continue;
      let point = center;
      if (dy !== 0) point = destinationPoint(point, dy > 0 ? 0 : 180, Math.abs(dy));
      if (dx !== 0) point = destinationPoint(point, dx > 0 ? 90 : 270, Math.abs(dx));
      tiles.push({ ...point, offsetMeters: offset });
    }
  }

  tiles.sort((a, b) => a.offsetMeters - b.offsetMeters);
  return tiles.slice(0, maxTiles).map(({ lat, lng }) => ({ lat, lng }));
}

/**
 * True when every point on the disc is inside at least one tile's search
 * circle. Used by the tests to prove a tiling is actually a covering rather
 * than a plausible-looking scatter of points.
 */
export function discIsCovered(center, radiusMeters, tiles, tileRadiusMeters, samplesPerRing = 72) {
  for (let ring = 0; ring <= 8; ring++) {
    const r = (radiusMeters * ring) / 8;
    const count = ring === 0 ? 1 : samplesPerRing;
    for (let i = 0; i < count; i++) {
      const probe = r === 0 ? center : destinationPoint(center, (360 * i) / count, r);
      const covered = tiles.some((t) => haversineMeters(t, probe) <= tileRadiusMeters);
      if (!covered) return false;
    }
  }
  return true;
}
