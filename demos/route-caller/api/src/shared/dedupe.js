// The dedupe engine, shared by the route pipeline and the area pipeline.
//
// Both answer the same question — "have I already got this place?" — and both
// answer it with normalized-name-within-150m. The area pipeline additionally
// has Google's place id from birth, so it can key on that first; the route
// pipeline does not pass a stable key and therefore behaves exactly as it
// always has.
//
// What differs between the two is only how a duplicate is absorbed (the route
// list needs the phone-bearing record to win; the area list needs the union of
// the industries that found it), so `absorb` is the caller's.

import { haversineMeters } from '../geo.js';
import { normalizeName } from './names.js';

export const DEDUPE_RADIUS_M = 150;

export function dedupeCandidates(lists, options = {}) {
  const {
    radiusMeters = DEDUPE_RADIUS_M,
    stableKeyOf = () => null,
    nameKeyOf = normalizeName,
    absorb,
  } = options;
  if (typeof absorb !== 'function') throw new Error('dedupeCandidates needs an absorb function');

  const merged = [];
  const byName = new Map();
  const byStable = new Map();

  for (const candidate of lists.flat()) {
    if (!candidate || candidate.lat == null || candidate.lng == null || !candidate.name) {
      continue;
    }

    // A stable id (Google's place id) is proof, and beats geometry: the same
    // business found by two industry searches is one row even if one of them
    // returned a slightly different display name.
    const stable = stableKeyOf(candidate);
    if (stable && byStable.has(stable)) {
      absorb(byStable.get(stable), candidate);
      continue;
    }

    const key = nameKeyOf(candidate.name);
    const bucket = byName.get(key) || [];
    const twin = bucket.find((existing) => haversineMeters(existing, candidate) <= radiusMeters);
    if (twin) {
      absorb(twin, candidate);
      if (stable) byStable.set(stable, twin);
      continue;
    }

    const record = { ...candidate };
    bucket.push(record);
    byName.set(key, bucket);
    if (stable) byStable.set(stable, record);
    merged.push(record);
  }
  return merged;
}
