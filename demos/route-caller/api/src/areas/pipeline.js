// Area pipeline: merge, dedupe, place relative to the centre, classify, sort.
// Free of Worker APIs so the tests exercise it directly.

import { haversineMeters } from '../geo.js';
import { dedupeCandidates } from '../shared/dedupe.js';
import { isTradeFranchise, isSupplierOrRetail } from './classify.js';
import { byLeadScore } from './leadScore.js';

/**
 * Absorb a duplicate.
 *
 * Different from route-caller's rule, and for a concrete reason: there, the
 * phone decided which of two SOURCES won, because a row without a number cannot
 * be dialled. Here both records are Google, so nothing has to win — the merge is
 * a union that fills gaps, and the one genuinely additive field is the set of
 * industries that found it. An HVAC company that also does plumbing is ONE row
 * that appears under both chips, never two rows she calls twice.
 */
function absorbArea(target, incoming) {
  target.phone = target.phone || incoming.phone || null;
  target.website = target.website || incoming.website || null;
  target.address = target.address || incoming.address || null;
  target.city = target.city || incoming.city || null;
  target.zip = target.zip || incoming.zip || null;
  target.primaryType = target.primaryType || incoming.primaryType || null;
  target.googlePlaceId = target.googlePlaceId || incoming.googlePlaceId || null;
  if (target.rating == null && incoming.rating != null) target.rating = incoming.rating;
  if (target.reviewCount == null && incoming.reviewCount != null) {
    target.reviewCount = incoming.reviewCount;
  }
  for (const key of incoming.industries || []) {
    if (!target.industries.includes(key)) target.industries.push(key);
  }
}

/**
 * Dedupe area candidates.
 *
 * Google's place id is available from birth here (unlike route-caller, which
 * merges in OSM rows that have none), so it is the primary key and
 * name-within-150m is only the fallback for a result that somehow arrived
 * without one.
 */
export function mergeAreaCandidates(lists) {
  return dedupeCandidates(lists, {
    stableKeyOf: (c) => c.googlePlaceId || null,
    absorb: absorbArea,
  });
}

/**
 * Attach distance from the centre and the junk flags, drop anything outside the
 * area's radius, and return in lead-score order.
 *
 * The radius filter is real: the outer ring of tiles searches PAST the edge of
 * the area on purpose (that is how the edge gets covered at all), so without
 * this a "30 mile" area would quietly contain 45-mile results.
 */
export function placeInArea(candidates, center, radiusMeters) {
  const placed = [];
  for (const c of candidates) {
    if (c.lat == null || c.lng == null) continue;
    const distance = haversineMeters(center, c);
    if (distance > radiusMeters) continue;
    placed.push({
      ...c,
      primaryType: c.primaryType || null,
      website: c.website || null,
      rating: c.rating ?? null,
      reviewCount: c.reviewCount ?? null,
      distance_from_center_m: Math.round(distance),
      review_count: c.reviewCount ?? null, // the column name, for the shared sorts
      is_franchise: isTradeFranchise(c.name) ? 1 : 0,
      is_supplier_or_retail: isSupplierOrRetail(c.name, c.primaryType) ? 1 : 0,
    });
  }
  placed.sort(byLeadScore);
  return placed;
}

/** Per-industry counts over a placed list, counting a row under every finder. */
export function countByIndustry(rows) {
  const counts = {};
  for (const row of rows) {
    const keys = Array.isArray(row.industries)
      ? row.industries
      : String(row.industries || row.industry || '').split(',').filter(Boolean);
    for (const key of keys) counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

/**
 * The shape of the review-count distribution, for the pilot report and for
 * judging whether an area is worth working at all.
 *
 * `unknown` is counted separately and never folded into a bucket: a NULL review
 * count means the field mask failed, not that a business has no reviews.
 */
export function reviewDistribution(rows) {
  const buckets = { '0': 0, '1-9': 0, '10-49': 0, '50-99': 0, '100-249': 0, '250+': 0 };
  let unknown = 0;
  for (const row of rows) {
    const n = row.review_count ?? row.reviewCount;
    if (n == null) { unknown++; continue; }
    if (n === 0) buckets['0']++;
    else if (n < 10) buckets['1-9']++;
    else if (n < 50) buckets['10-49']++;
    else if (n < 100) buckets['50-99']++;
    else if (n < 250) buckets['100-249']++;
    else buckets['250+']++;
  }
  return { buckets, unknown };
}

/** No website, and not junk — the number Vertizin actually cares about. */
export function noWebsiteCount(rows) {
  return rows.filter(
    (r) => !r.website && !r.is_franchise && !r.is_supplier_or_retail
  ).length;
}
