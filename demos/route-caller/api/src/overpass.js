// OpenStreetMap via Overpass. Etiquette: one batched query per route, a real
// User-Agent, and a single retry after a pause on 429/504.

const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'route-caller/1.0 (github.com/mrmicaiah/website-demos)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One query covering the whole corridor: Overpass `around` accepts a linestring
 * of coordinates, so the sampled route points define the corridor directly.
 */
export function buildQuery(samplePoints, radiusMeters = 16000) {
  const coords = samplePoints
    .map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`)
    .join(',');
  const around = `(around:${radiusMeters},${coords})`;
  return `[out:json][timeout:60];
(
  nwr["amenity"="childcare"]${around};
  nwr["amenity"="kindergarten"]${around};
  nwr["preschool"="yes"]${around};
);
out center tags;`;
}

export async function fetchOverpass(samplePoints, radiusMeters = 16000) {
  const query = buildQuery(samplePoints, radiusMeters);
  let res = await post(query);
  if (res.status === 429 || res.status === 504) {
    await sleep(2500);
    res = await post(query);
  }
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const data = await res.json();
  return (data.elements || []).map(toCandidate).filter((c) => c.lat != null && c.name);
}

function post(query) {
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: `data=${encodeURIComponent(query)}`,
  });
}

function toCandidate(el) {
  const tags = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  const address =
    [street, tags['addr:city'], tags['addr:state'], tags['addr:postcode']]
      .filter(Boolean)
      .join(', ') || null;
  return {
    externalId: `osm-${el.type}-${el.id}`,
    name: tags.name || tags['operator'] || null,
    address,
    city: tags['addr:city'] || null,
    zip: tags['addr:postcode'] || null,
    phone: tags.phone || tags['contact:phone'] || null,
    lat,
    lng,
    source: 'osm',
    tags,
  };
}
