// OpenStreetMap via Overpass.
//
// The corridor is queried in chunks of sample points rather than as one giant
// `around` linestring, and the chunk size is small for a measured reason.
//
// Long routes were coming back HTTP 521. That is not Overpass being down: the
// same queries succeed from a laptop. Overpass's cost is superlinear in the
// number of `around` anchor points, and 521 is a Cloudflare edge timeout in
// front of a slow origin. Measured on the Gatlinburg corridor, all four tag
// clauses:
//     9 points -> 42 s  (Worker gets 521)
//     4 points -> 4.6 s
//     2 points -> 1.9 s
// So the fix is small chunks, not merely chunks. Four is comfortably clear of
// the timeout with room for denser corridors.
//
// Subrequest budget (Workers caps these per request; 50 on the free plan):
//   2 geocode + 1 routing + up to 25 Places nearby + 1 Places text = 29 Google
//   + ceil(25 / 4) = 7 Overpass chunks             = 36 typical
//   + one retry on every chunk (worst case)        = 43
// Under the cap, but no longer roomy. Two things would break it: raising
// MAX_SAMPLES in index.js, or the Places lean-mask retry firing, which would
// double the 25 nearby calls if this account ever loses the Enterprise SKU.
// If either happens, lower MAX_SAMPLES first.
//
// The cost is wall time: seven sequential chunks plus polite delays puts a long
// route around 40-50 s end to end. The frontend's loading state covers it.

const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'route-caller/1.0 (github.com/mrmicaiah/website-demos)';

/** Sample points per Overpass query. See the timings above before raising this. */
export const CHUNK_SIZE = 4;
const POLITE_DELAY_MS = 1000;

// 429 is rate limiting; 502/503/504/521 are Overpass being down or overloaded,
// which it intermittently is. One retry, then that chunk is given up on.
const RETRYABLE = new Set([429, 502, 503, 504, 521]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Split the sampled corridor into groups of at most `size` points. */
export function chunkSamples(points, size = CHUNK_SIZE) {
  if (!points || !points.length) return [];
  const chunks = [];
  for (let i = 0; i < points.length; i += size) {
    chunks.push(points.slice(i, i + size));
  }
  return chunks;
}

/**
 * One query covering a chunk of the corridor: Overpass `around` accepts a
 * linestring of coordinates, so the sample points define the corridor directly.
 * Facilities and mapped playgrounds come back together and are told apart on tags.
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
  nwr["leisure"="playground"]${around};
);
out center tags;`;
}

/**
 * Merge per-chunk results, deduping by OSM element id. Adjacent chunks overlap
 * by design, so without this the same facility would be counted several times
 * and the dedupe in pipeline.js would have to clean up after us.
 */
export function mergeChunkResults(results) {
  const facilities = new Map();
  const playgrounds = new Map();
  for (const result of results || []) {
    for (const facility of result?.facilities || []) {
      if (!facilities.has(facility.externalId)) facilities.set(facility.externalId, facility);
    }
    for (const playground of result?.playgrounds || []) {
      if (!playgrounds.has(playground.id)) playgrounds.set(playground.id, playground);
    }
  }
  return {
    facilities: [...facilities.values()],
    playgrounds: [...playgrounds.values()],
  };
}

/**
 * Query the whole corridor, chunk by chunk.
 *
 * Returns { facilities, playgrounds, chunksTotal, chunksOk }. All chunks
 * succeeding is a clean `ok`; some succeeding is a partial result the caller
 * records as such; none succeeding throws, and the caller degrades to
 * Google-only exactly as before.
 */
export async function fetchOverpass(samplePoints, radiusMeters = 16000, chunkSize = CHUNK_SIZE) {
  const chunks = chunkSamples(samplePoints, chunkSize);
  const results = [];
  const errors = [];

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleep(POLITE_DELAY_MS);
    try {
      results.push(await fetchChunk(chunks[i], radiusMeters));
    } catch (err) {
      errors.push(err.message);
    }
  }

  if (!results.length) {
    throw new Error(errors[0] || 'Overpass returned nothing for any chunk');
  }
  return {
    ...mergeChunkResults(results),
    chunksTotal: chunks.length,
    chunksOk: results.length,
  };
}

async function fetchChunk(samplePoints, radiusMeters) {
  const query = buildQuery(samplePoints, radiusMeters);
  let res = await post(query);
  if (RETRYABLE.has(res.status)) {
    await sleep(3000);
    res = await post(query);
  }
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const data = await res.json();
  return splitElements(data.elements || []);
}

/** Separate mapped playgrounds from facility records. */
export function splitElements(elements) {
  const playgrounds = [];
  const facilities = [];
  for (const el of elements) {
    const tags = el.tags || {};
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat == null || lng == null) continue;
    if (tags.leisure === 'playground') {
      playgrounds.push({ id: `osm-${el.type}-${el.id}`, lat, lng });
      continue;
    }
    const candidate = toCandidate(el, lat, lng);
    if (candidate.name) facilities.push(candidate);
  }
  return { facilities, playgrounds };
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

function toCandidate(el, lat, lng) {
  const tags = el.tags || {};
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
    website: tags.website || tags['contact:website'] || null,
    lat,
    lng,
    source: 'osm',
    tags,
  };
}
