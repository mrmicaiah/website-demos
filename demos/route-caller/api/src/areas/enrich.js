// In-place enrichment for an area that has been worked.
//
// Same rails as route-caller, running the same shared code: her status, flags
// and notes are snapshotted before any write and verified against the database
// after, in production, every run. Nothing is ever deleted.
//
// The area case is easier in one way and harder in another. Easier: every row
// has had `google_place_id` since birth, so matching is an exact key and the
// name+geo fallback is only there for completeness. Harder: `review_count` is
// the field most worth re-checking and it is also the field that CHANGES, so
// unlike route-caller's fill-from-NULL columns it genuinely refreshes.

import { haversineMeters } from '../geo.js';
import { normalizeName } from '../shared/names.js';
import { makePatchAssertion, makeSnapshotRails } from '../shared/snapshot.js';
import { isTradeFranchise, isSupplierOrRetail } from './classify.js';

const MATCH_RADIUS_M = 150;

/** Columns an area enrichment may never write. Enforced, not just documented. */
export const AREA_PROTECTED_COLUMNS = new Set([
  'id',
  'area_id',
  'name',
  'status',
  'flagged',
  'notes',
  'lat',
  'lng',
  'distance_from_center_m',
  'industry', // the FIRST finder is a historical fact; `industries` is the growing one
  // A booked brainstorm and a scheduled retry are as much his work as a note is.
  // Re-checking a town must never move a meeting.
  'meeting_at',
  'follow_up_date',
]);

export const assertAreaPatchIsSafe = makePatchAssertion(AREA_PROTECTED_COLUMNS);

/**
 * The area rails guard the two pipeline dates as well as status/flagged/notes,
 * so an enrichment run that silently cleared a meeting would be caught in
 * production, not just in review.
 */
export const { snapshotOf, verifySnapshot } = makeSnapshotRails([
  'meeting_at',
  'follow_up_date',
]);

/**
 * Decide, per candidate: update an existing row, insert a new one, or too
 * ambiguous to touch. A candidate matching TWO stored rows updates neither —
 * guessing would write one business's data onto another's row on a list she is
 * calling. They are reported instead.
 */
export function matchAreaCandidates(candidates, existingRows, radiusMeters = MATCH_RADIUS_M) {
  const byPlaceId = new Map();
  for (const row of existingRows) {
    if (row.google_place_id) byPlaceId.set(row.google_place_id, row);
  }
  const byName = new Map();
  for (const row of existingRows) {
    const key = normalizeName(row.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(row);
  }

  const updates = [];
  const inserts = [];
  const ambiguous = [];
  const claimed = new Set();

  for (const candidate of candidates) {
    const exact = candidate.googlePlaceId ? byPlaceId.get(candidate.googlePlaceId) : null;
    if (exact) {
      if (!claimed.has(exact.id)) {
        claimed.add(exact.id);
        updates.push({ row: exact, candidate, matchedBy: 'place_id' });
      }
      continue;
    }
    const sameName = byName.get(normalizeName(candidate.name)) || [];
    const near = sameName.filter(
      (row) => row.lat != null && row.lng != null && haversineMeters(row, candidate) <= radiusMeters
    );
    if (near.length === 0) inserts.push(candidate);
    else if (near.length === 1) {
      const row = near[0];
      if (!claimed.has(row.id)) {
        claimed.add(row.id);
        updates.push({ row, candidate, matchedBy: 'name_geo' });
      }
    } else ambiguous.push({ candidate, rows: near });
  }

  return { updates, inserts, ambiguous };
}

const industriesOf = (value) =>
  String(value || '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * The columns an area update is allowed to write, and nothing else. Returns
 * null when there is nothing to change, so untouched rows never see a write.
 *
 * - `phone` and `website` fill only from NULL. She may have corrected a number,
 *   and a "no website" badge must not flip out from under her mid-call — a
 *   business that builds a website is next month's decision, not this call's.
 * - `rating` and `review_count` DO refresh. They are pure Google facts she never
 *   edits, and their staleness is the reason to re-check an area at all.
 * - `industries` only ever GROWS. Discovering that an HVAC row also answers a
 *   plumbing search adds a chip; it never removes one.
 * - The junk flags are derived, so they are recomputed from whatever name and
 *   type the row will hold after this update.
 */
export function areaEnrichmentPatch(row, candidate = {}) {
  const patch = {};

  if (!row.phone && candidate.phone) patch.phone = candidate.phone;
  if (!row.website && candidate.website) patch.website = candidate.website;
  if (!row.primary_type && candidate.primaryType) patch.primary_type = candidate.primaryType;
  if (!row.google_place_id && candidate.googlePlaceId) {
    patch.google_place_id = candidate.googlePlaceId;
  }
  if (candidate.rating != null && candidate.rating !== row.rating) patch.rating = candidate.rating;
  if (candidate.reviewCount != null && candidate.reviewCount !== row.review_count) {
    patch.review_count = candidate.reviewCount;
  }

  const known = industriesOf(row.industries || row.industry);
  const merged = [...known];
  for (const key of candidate.industries || []) {
    if (!merged.includes(key)) merged.push(key);
  }
  if (merged.length !== known.length) patch.industries = merged.join(',');

  const effectiveType = patch.primary_type ?? row.primary_type ?? null;
  const flags = {
    is_franchise: isTradeFranchise(row.name) ? 1 : 0,
    is_supplier_or_retail: isSupplierOrRetail(row.name, effectiveType) ? 1 : 0,
  };
  for (const [column, value] of Object.entries(flags)) {
    if ((row[column] ? 1 : 0) !== value) patch[column] = value;
  }

  return Object.keys(patch).length ? patch : null;
}
