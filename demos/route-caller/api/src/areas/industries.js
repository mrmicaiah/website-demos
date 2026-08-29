// The industry menu — DATA, so adding a trade later is an edit here and nothing
// else. The frontend reads this list through GET /api/industries rather than
// keeping its own copy.
//
// Each industry maps to Google Places (New) `includedTypes` plus text queries
// for the coverage the types miss. Two things are deliberate:
//
// - `types` is a HOPE, not a fact. Places (New) adds and renames Table A types,
//   and an unknown type makes the whole searchNearby call 400. So the pipeline
//   PROBES each industry's types once per run and falls back to `tileQueries`
//   per tile if they are rejected. Nothing here can fail an area.
//   MEASURED, 2026-08-29: `hvac_contractor` does NOT exist in Places (New) and
//   is rejected. HVAC runs on text, which is why it carries two phrasings —
//   half the HVAC companies in Huntsville are typed `general_contractor` and
//   named "... Heating and Air", and one query phrase missed them.
// - `textQueries` run once per area at the full radius. They are broad sweeps
//   for coverage, capped at 20 results each by Google, so they supplement the
//   tiled searches rather than replacing them.

export const INDUSTRIES = [
  {
    key: 'hvac',
    label: 'HVAC',
    types: ['hvac_contractor'],
    textQueries: ['HVAC contractor', 'heating and air'],
    // The tile-level fallback when `types` is rejected or empty. EVERY phrasing
    // runs per tile: text search matches the business's profile text, so
    // "HVAC contractor" and "heating and air conditioning" return substantially
    // different companies. One phrase is not coverage.
    tileQueries: ['HVAC contractor', 'heating and air conditioning'],
    defaultOn: true,
  },
  {
    key: 'plumbing',
    label: 'Plumbing',
    types: ['plumber'],
    textQueries: ['plumbing company'],
    tileQueries: ['plumber'],
    defaultOn: true,
  },
  {
    key: 'roofing',
    label: 'Roofing',
    types: ['roofing_contractor'],
    textQueries: ['roofing company'],
    tileQueries: ['roofing contractor'],
    defaultOn: false,
  },
  {
    key: 'electrical',
    label: 'Electrical',
    types: ['electrician'],
    textQueries: [],
    tileQueries: ['electrician'],
    defaultOn: false,
  },
  {
    key: 'septic',
    label: 'Septic',
    types: [], // no clean Places type exists
    textQueries: ['septic service', 'septic pumping'],
    tileQueries: ['septic service', 'septic pumping'],
    defaultOn: false,
  },
  {
    key: 'tree',
    label: 'Tree service',
    types: [],
    textQueries: ['tree service'],
    tileQueries: ['tree service'],
    defaultOn: false,
  },
  {
    key: 'foundation',
    label: 'Foundation / concrete',
    types: [],
    textQueries: ['foundation repair'],
    tileQueries: ['foundation repair'],
    defaultOn: false,
  },
];

const BY_KEY = new Map(INDUSTRIES.map((i) => [i.key, i]));

export const industryByKey = (key) => BY_KEY.get(key) || null;

export const DEFAULT_INDUSTRY_KEYS = INDUSTRIES.filter((i) => i.defaultOn).map((i) => i.key);

/** Validate and normalize a requested set of industry keys, preserving menu order. */
export function resolveIndustries(keys) {
  const wanted = new Set(Array.isArray(keys) ? keys : []);
  const resolved = INDUSTRIES.filter((i) => wanted.has(i.key));
  const unknown = [...wanted].filter((k) => !BY_KEY.has(k));
  return { industries: resolved, unknown };
}

export const industryLabel = (key) => industryByKey(key)?.label || key;
