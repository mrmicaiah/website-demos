// Google Places calls for the area pipeline.
//
// Shares the Worker's key (a secret, never in frontend code) and the same
// full-mask-then-lean-mask degradation route-caller uses. What is different:
// the field mask carries `rating` and `userRatingCount`, because review count
// is the "established business" proxy this product sorts on.

import { ApiError } from '../google.js';
import { destinationPoint } from '../geo.js';

// rating + userRatingCount bill in the same Places Enterprise tier as
// nationalPhoneNumber and websiteUri, which this account already has — so
// asking for them costs no extra SKU.
const FULL_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.primaryType',
  'places.nationalPhoneNumber',
  'places.websiteUri',
  'places.rating',
  'places.userRatingCount',
  'places.addressComponents',
].join(',');

// Pro-tier fallback. Under this mask website, rating and review count all come
// back NULL — which is why the UI checks whether ANY row on an area has a
// website before it shows a "no website" badge. A badge that is really a
// property of the field mask would be a lie told to a caller.
const LEAN_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.primaryType',
].join(',');

async function placesPost(path, body, key, mask) {
  return fetch(`https://places.googleapis.com/v1/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': mask,
    },
    body: JSON.stringify(body),
  });
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}

/** Thrown when Places rejects an industry's includedTypes, so the caller can fall back. */
export class UnsupportedTypes extends Error {}

async function runSearch(path, body, key) {
  let res = await placesPost(path, body, key, FULL_MASK);
  let leanUsed = false;
  if (res.status === 400) {
    res = await placesPost(path, body, key, LEAN_MASK);
    leanUsed = true;
  }
  if (res.status === 400) {
    // Both masks rejected: it is the request body, not the SKU. For a nearby
    // search that means an includedType Places does not know.
    throw new UnsupportedTypes(await safeText(res));
  }
  if (!res.ok) throw new ApiError(`Places search failed: ${await safeText(res)}`);
  const data = await res.json();
  return { places: data.places || [], leanUsed };
}

/** Nearby search for one industry's types, around one tile. */
export async function searchNearbyTypes(point, types, key, radius) {
  return runSearch(
    'places:searchNearby',
    {
      includedTypes: types,
      maxResultCount: 20,
      // 20 results is the hard cap. Ranking by distance means a saturated tile
      // sheds its FARTHEST results, and the tile next to it covers those.
      rankPreference: 'DISTANCE',
      locationRestriction: {
        circle: { center: { latitude: point.lat, longitude: point.lng }, radius },
      },
    },
    key
  );
}

/**
 * The square that circumscribes a tile's search circle.
 *
 * Text Search does NOT accept a circle in `locationRestriction` — only a
 * rectangle. Measured the hard way on 2026-08-29: every per-tile HVAC search in
 * the first Huntsville pilot 400'd on a circle and was swallowed by the
 * per-tile catch, so the run made 45 extra calls and returned exactly the same
 * 496 results. A search that silently returns nothing is worse than one that
 * fails loudly, which is why the pipeline now counts tile failures.
 */
export function tileRectangle(point, radius) {
  const north = destinationPoint(point, 0, radius);
  const south = destinationPoint(point, 180, radius);
  const east = destinationPoint(point, 90, radius);
  const west = destinationPoint(point, 270, radius);
  return {
    low: { latitude: south.lat, longitude: west.lng },
    high: { latitude: north.lat, longitude: east.lng },
  };
}

/** Text search restricted to one tile — the fallback when an industry has no usable type. */
export async function searchTextInCircle(point, textQuery, key, radius) {
  return runSearch(
    'places:searchText',
    {
      textQuery,
      maxResultCount: 20,
      rankPreference: 'DISTANCE',
      locationRestriction: { rectangle: tileRectangle(point, radius) },
    },
    key
  );
}

/** One broad text sweep over the whole area. Best-effort extra coverage. */
export async function searchTextInArea(center, textQuery, key, radius) {
  return runSearch(
    'places:searchText',
    {
      textQuery,
      maxResultCount: 20,
      locationBias: {
        circle: { center: { latitude: center.lat, longitude: center.lng }, radius },
      },
    },
    key
  );
}

function componentValue(components, type) {
  return components?.find((c) => (c.types || []).includes(type))?.shortText || null;
}

function parseAddress(formatted) {
  if (!formatted) return { city: null, zip: null };
  const parts = formatted.split(',').map((s) => s.trim());
  const zipMatch = formatted.match(/\b(\d{5})(?:-\d{4})?\b/);
  const city = parts.length >= 3 ? parts[parts.length - 3] : null;
  return { city, zip: zipMatch ? zipMatch[1] : null };
}

/** A Places result → an area candidate, tagged with the industry that found it. */
export function toAreaCandidate(place, industryKey) {
  const formatted = place.formattedAddress || null;
  const parsed = parseAddress(formatted);
  return {
    googlePlaceId: place.id || null,
    industry: industryKey,
    industries: [industryKey],
    name: place.displayName?.text || 'Unnamed business',
    address: formatted,
    city: componentValue(place.addressComponents, 'locality') || parsed.city,
    zip: componentValue(place.addressComponents, 'postal_code') || parsed.zip,
    phone: place.nationalPhoneNumber || null,
    website: place.websiteUri || null,
    lat: place.location?.latitude,
    lng: place.location?.longitude,
    rating: typeof place.rating === 'number' ? place.rating : null,
    reviewCount: typeof place.userRatingCount === 'number' ? place.userRatingCount : null,
    primaryType: place.primaryType || null,
  };
}
