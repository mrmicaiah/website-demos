// In-place enrichment for routes that can never be re-ingested.
//
// A route the caller has worked holds her status, flags and notes. Re-ingesting
// it would destroy them, so a route with any call activity was previously frozen
// with whatever data its first ingest happened to capture. This closes that gap:
// existing rows gain enrichment columns, new facilities are inserted alongside
// them, and nothing she has written is touched.
//
// Everything here is a pure function so the safety rules can be tested directly.

import { haversineMeters } from './geo.js';
import { makePatchAssertion, snapshotOf, verifySnapshot } from './shared/snapshot.js';
import { normalizeName, isFranchise, isHomeDaycare, isSchoolProgram, isPlaygroundUnlikely } from './heuristics.js';

const MATCH_RADIUS_M = 150;

/**
 * Decide, for each incoming candidate, whether it updates a row we already have,
 * inserts as a new one, or is too ambiguous to touch.
 *
 * Google's place id is the stable key and wins outright. Legacy rows have none,
 * so those fall back to the same normalized-name-within-150m rule the ingest
 * dedupe uses.
 *
 * A candidate matching TWO existing rows updates neither. Guessing there would
 * silently write one facility's data onto another's row — on a route she is
 * actively calling. They are reported for review instead.
 */
export function matchCandidates(candidates, existingRows, radiusMeters = MATCH_RADIUS_M) {
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
      (row) =>
        row.lat != null &&
        row.lng != null &&
        haversineMeters(row, candidate) <= radiusMeters
    );

    if (near.length === 0) {
      inserts.push(candidate);
    } else if (near.length === 1) {
      const row = near[0];
      if (!claimed.has(row.id)) {
        claimed.add(row.id);
        updates.push({ row, candidate, matchedBy: 'name_geo' });
      }
    } else {
      ambiguous.push({ candidate, rows: near });
    }
  }

  return { updates, inserts, ambiguous };
}

/**
 * The columns an update is allowed to write, and nothing else.
 *
 * Returns null when there is nothing to change, so untouched rows never see a
 * write at all.
 *
 * Rules, in the order they matter:
 * - `status`, `flagged`, `notes`, `name`, `id` and the geometry are NEVER here.
 * - `phone` fills only from NULL. She may have corrected a number or be calling
 *   it right now; a fresher value from Google is not worth overwriting that.
 * - `website` and `primary_type` fill only from NULL, for the same reason in a
 *   milder form: the stored value came from an equally authoritative ingest.
 * - `playground_nearby` only ever goes 0 -> 1. Overpass is frequently partial,
 *   so the absence of a mapped playground is not evidence there is none, and
 *   clearing the flag would destroy a real signal on a bad Overpass day.
 * - The classifier flags are derived, so they are recomputed from whatever name
 *   and type the row will hold after this update.
 */
export function enrichmentPatch(row, candidate = {}, playgroundNearby = false) {
  const patch = {};

  if (!row.phone && candidate.phone) patch.phone = candidate.phone;
  if (!row.website && candidate.website) patch.website = candidate.website;
  if (!row.primary_type && candidate.primaryType) patch.primary_type = candidate.primaryType;
  if (!row.google_place_id && candidate.googlePlaceId) {
    patch.google_place_id = candidate.googlePlaceId;
  }
  if (playgroundNearby && !row.playground_nearby) patch.playground_nearby = 1;

  const effectiveType = patch.primary_type ?? row.primary_type ?? null;
  const flags = {
    is_school_program: isSchoolProgram(row.name, {}, effectiveType) ? 1 : 0,
    is_franchise: isFranchise(row.name) ? 1 : 0,
    is_home_daycare: isHomeDaycare(row.name, {}) ? 1 : 0,
    playground_unlikely: isPlaygroundUnlikely(row.name, effectiveType) ? 1 : 0,
  };
  for (const [column, value] of Object.entries(flags)) {
    if ((row[column] ? 1 : 0) !== value) patch[column] = value;
  }

  return Object.keys(patch).length ? patch : null;
}

/** Columns an enrichment update may never write. Enforced, not just documented. */
export const PROTECTED_COLUMNS = new Set([
  'id',
  'route_id',
  'name',
  'status',
  'flagged',
  'notes',
  'distance_from_route_m',
  'position_along_route_m',
  'lat',
  'lng',
]);

export const assertPatchIsSafe = makePatchAssertion(PROTECTED_COLUMNS);

/**
 * The snapshot rails themselves live in shared/snapshot.js — the area pipeline
 * runs the same code, not a copy of it. Re-exported here so `enrich.js` stays
 * the one place a reader has to look for route enrichment safety.
 *
 * `verifySnapshot` runs in production on every enrichment, not only in tests:
 * the whole point is that it executes against a route she is working.
 */
export { snapshotOf, verifySnapshot };
