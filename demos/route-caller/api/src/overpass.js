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
//   + ceil(25 / 4) = 7 Overpass chunks                             = 36 typical
// Mirror fallback adds calls, so rather than reason about the worst case it is
// enforced: MAX_OVERPASS_REQUESTS caps Overpass at 20 calls per route, giving a
// hard ceiling of 29 + 20 = 49, one under the limit. Because a dead endpoint is
// retired for the whole route after its first failure, a full failover costs
// about 2 wasted calls, not 2 per chunk: primary dies (1), first mirror dies
// (1), the second mirror serves all 7 chunks = 9 total.
// The thing that would still break the budget is raising MAX_SAMPLES in
// index.js, or the Places lean-mask retry firing, which would double the 25
// nearby calls if this account ever loses the Enterprise SKU. Lower MAX_SAMPLES
// first if either happens.
//
// The cost is wall time: seven sequential chunks plus polite delays puts a long
// route around 40-50 s end to end. The frontend's loading state covers it.

export const DEFAULT_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const MIRRORS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const USER_AGENT = 'route-caller/1.0 (github.com/mrmicaiah/website-demos)';

/**
 * Ordered endpoints to try: the configured primary (OVERPASS_URL) first, then
 * every other known endpoint as a fallback, with nothing repeated. Setting
 * OVERPASS_URL to a mirror promotes it without losing the main endpoint as a
 * fallback; setting it to something unknown adds it in front of them all.
 */
export function endpointList(primary = DEFAULT_ENDPOINT) {
  const first = primary || DEFAULT_ENDPOINT;
  const rest = [DEFAULT_ENDPOINT, ...MIRRORS].filter((url) => url !== first);
  return [first, ...rest];
}

/**
 * Hard ceiling on Overpass HTTP calls per route, enforced by a counter rather
 * than by reasoning about worst cases. 50 subrequest cap minus 29 Google calls
 * leaves 21; 20 keeps a call in hand. When it runs out, remaining chunks are
 * reported failed and the route degrades exactly as if Overpass were down.
 */
export const MAX_OVERPASS_REQUESTS = 20;

// A broken path to this endpoint, so retrying it is pointless — move on. 500 is
// in here from observation: both mirrors return it consistently for queries the
// main endpoint serves, so for our purposes they are simply unusable.
const HANDSHAKE_CLASS = new Set([500, 520, 521, 522, 523, 524, 525, 526]);
// Overloaded or rate limited: worth one retry against the same endpoint.
const TEMPORARY = new Set([429, 502, 503, 504]);

/** Sample points per Overpass query. See the timings above before raising this. */
export const CHUNK_SIZE = 4;
const POLITE_DELAY_MS = 1000;

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
export async function fetchOverpass(samplePoints, radiusMeters = 16000, options = {}) {
  const {
    chunkSize = CHUNK_SIZE,
    endpoints = endpointList(),
    maxRequests = MAX_OVERPASS_REQUESTS,
  } = options;

  const chunks = chunkSamples(samplePoints, chunkSize);
  const state = {
    endpoints,
    index: 0, // sticky: the first endpoint still worth trying
    requests: 0,
    maxRequests,
    served: new Set(),
    lastError: null,
    // host -> what it last returned, so a total failure can still say why.
    errors: {},
  };

  const results = [];
  for (let i = 0; i < chunks.length; i++) {
    if (state.requests >= state.maxRequests) {
      state.lastError = state.lastError || 'Overpass subrequest budget exhausted';
      break;
    }
    if (i > 0) await sleep(POLITE_DELAY_MS);
    const result = await fetchChunkWithFallback(chunks[i], radiusMeters, state);
    if (result) results.push(result);
  }

  // Never throws: a total failure is a result with chunksOk 0, so the caller
  // still gets the diagnostics (which endpoints were tried, what each said).
  return {
    ...mergeChunkResults(results),
    chunksTotal: chunks.length,
    chunksOk: results.length,
    endpointsUsed: [...state.served],
    requests: state.requests,
    errors: state.errors,
    lastError: state.lastError,
  };
}

/**
 * One chunk, walking the endpoint list. A handshake-class failure retires that
 * endpoint for the rest of the route (sticky), so a dead primary costs one
 * wasted call rather than one per chunk.
 */
async function fetchChunkWithFallback(chunk, radiusMeters, state) {
  for (let i = state.index; i < state.endpoints.length; i++) {
    const url = state.endpoints[i];

    let attempt = await tryChunk(url, chunk, radiusMeters, state);
    if (attempt.ok) {
      state.index = i;
      state.served.add(url);
      return attempt.data;
    }
    // An endpoint that has already served this route is intermittent, not
    // broken — overpass-api.de does exactly this, serving some chunks and 521ing
    // others. Retry it rather than falling through to mirrors that can't help.
    const proven = state.served.has(url);
    if ((attempt.temporary || proven) && state.requests < state.maxRequests) {
      await sleep(3000);
      attempt = await tryChunk(url, chunk, radiusMeters, state);
      if (attempt.ok) {
        state.index = i;
        state.served.add(url);
        return attempt.data;
      }
    }
    // Retire an endpoint that has never worked. One that has served before is
    // kept: retiring the primary mid-route is how coverage was being lost.
    if (attempt.handshake && i === state.index && !state.served.has(url)) {
      state.index = i + 1;
    }
    if (state.requests >= state.maxRequests) break;
  }
  return null;
}

async function tryChunk(url, chunk, radiusMeters, state) {
  if (state.requests >= state.maxRequests) {
    return { ok: false, handshake: false, temporary: false };
  }
  state.requests++;
  try {
    const res = await post(url, buildQuery(chunk, radiusMeters));
    if (res.ok) {
      const data = await res.json();
      return { ok: true, data: splitElements(data.elements || []) };
    }
    state.lastError = `Overpass HTTP ${res.status}`;
    state.errors[hostOf(url)] = `HTTP ${res.status}`;
    return {
      ok: false,
      handshake: HANDSHAKE_CLASS.has(res.status),
      temporary: TEMPORARY.has(res.status),
    };
  } catch (err) {
    // A thrown fetch is a broken path, same as a handshake failure.
    state.lastError = `Overpass ${String(err.message).slice(0, 80)}`;
    state.errors[hostOf(url)] = String(err.message).slice(0, 60);
    return { ok: false, handshake: true, temporary: false };
  }
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

function post(url, query) {
  return fetch(url, {
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

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
