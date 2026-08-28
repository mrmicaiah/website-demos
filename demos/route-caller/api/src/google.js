// Google API calls. The key is a Worker secret (GOOGLE_MAPS_API_KEY) and never
// leaves the Worker — the frontend talks only to this Worker.

export class ApiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const NEARBY_TYPES = ['child_care_agency', 'preschool'];

const FULL_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.nationalPhoneNumber',
  'places.addressComponents',
].join(',');

// Fallback if the account's Places SKU rejects the richer mask.
const LEAN_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
].join(',');

export async function geocode(address, key) {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', address);
  url.searchParams.set('key', key);
  const res = await fetch(url, { headers: { 'User-Agent': 'route-caller/1.0' } });
  if (!res.ok) throw new ApiError(`Geocoding request failed (HTTP ${res.status})`);
  const data = await res.json();
  if (data.status !== 'OK' || !data.results?.length) {
    throw new ApiError(
      `Could not geocode "${address}"${data.status ? ` (${data.status})` : ''}`,
      400
    );
  }
  const top = data.results[0];
  return {
    lat: top.geometry.location.lat,
    lng: top.geometry.location.lng,
    formatted: top.formatted_address,
  };
}

/** Driving route between two coords → { encodedPolyline, distanceMeters }. */
export async function computeRoute(start, end, key) {
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'routes.polyline.encodedPolyline,routes.distanceMeters',
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: start.lat, longitude: start.lng } } },
      destination: { location: { latLng: { latitude: end.lat, longitude: end.lng } } },
      travelMode: 'DRIVE',
    }),
  });
  if (res.ok) {
    const data = await res.json();
    const route = data.routes?.[0];
    if (route?.polyline?.encodedPolyline) {
      return {
        encodedPolyline: route.polyline.encodedPolyline,
        distanceMeters: route.distanceMeters ?? null,
      };
    }
  }
  return legacyDirections(start, end, key, await safeText(res));
}

async function legacyDirections(start, end, key, routesErr) {
  const url = new URL('https://maps.googleapis.com/maps/api/directions/json');
  url.searchParams.set('origin', `${start.lat},${start.lng}`);
  url.searchParams.set('destination', `${end.lat},${end.lng}`);
  url.searchParams.set('mode', 'driving');
  url.searchParams.set('key', key);
  const res = await fetch(url);
  const data = res.ok ? await res.json() : null;
  const poly = data?.routes?.[0]?.overview_polyline?.points;
  if (!poly) {
    throw new ApiError(
      `No driving route found. Routes API said: ${routesErr || 'unknown error'}`,
      502
    );
  }
  return {
    encodedPolyline: poly,
    distanceMeters: data.routes[0].legs?.reduce((s, l) => s + (l.distance?.value || 0), 0) ?? null,
  };
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}

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

/** Nearby child-care search around one sample point. */
export async function searchNearby(point, key, radius = 16000) {
  const body = {
    includedTypes: NEARBY_TYPES,
    maxResultCount: 20,
    locationRestriction: {
      circle: {
        center: { latitude: point.lat, longitude: point.lng },
        radius,
      },
    },
  };
  let res = await placesPost('places:searchNearby', body, key, FULL_MASK);
  if (res.status === 400) {
    res = await placesPost('places:searchNearby', body, key, LEAN_MASK);
  }
  if (!res.ok) throw new ApiError(`Places nearby search failed: ${await safeText(res)}`);
  const data = await res.json();
  return (data.places || []).map(toCandidate);
}

/**
 * One text search biased along the whole route. Best-effort extra coverage on
 * top of the per-sample-point nearby searches; callers ignore failures.
 */
export async function searchAlongRoute(encodedPolyline, key) {
  const body = {
    textQuery: 'child care daycare preschool',
    maxResultCount: 20,
    searchAlongRouteParameters: { polyline: { encodedPolyline } },
  };
  let res = await placesPost('places:searchText', body, key, FULL_MASK);
  if (res.status === 400) {
    res = await placesPost('places:searchText', body, key, LEAN_MASK);
  }
  if (!res.ok) throw new ApiError(`Places text search failed: ${await safeText(res)}`);
  const data = await res.json();
  return (data.places || []).map(toCandidate);
}

function componentValue(components, type) {
  return components?.find((c) => (c.types || []).includes(type))?.shortText || null;
}

/** Pull city/ZIP out of a formatted address when addressComponents are absent. */
function parseAddress(formatted) {
  if (!formatted) return { city: null, zip: null };
  const parts = formatted.split(',').map((s) => s.trim());
  const zipMatch = formatted.match(/\b(\d{5})(?:-\d{4})?\b/);
  const city = parts.length >= 3 ? parts[parts.length - 3] : null;
  return { city, zip: zipMatch ? zipMatch[1] : null };
}

function toCandidate(place) {
  const formatted = place.formattedAddress || null;
  const parsed = parseAddress(formatted);
  return {
    externalId: place.id,
    name: place.displayName?.text || 'Unnamed facility',
    address: formatted,
    city: componentValue(place.addressComponents, 'locality') || parsed.city,
    zip: componentValue(place.addressComponents, 'postal_code') || parsed.zip,
    phone: place.nationalPhoneNumber || null,
    lat: place.location?.latitude,
    lng: place.location?.longitude,
    source: 'google',
    tags: {},
  };
}
