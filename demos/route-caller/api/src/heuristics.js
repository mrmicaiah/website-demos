// Name/tag heuristics. These only set flags — the UI filters on them and the
// data is never discarded. Phase 2 replaces the home-daycare guess with
// authoritative state licensing data.

const FRANCHISES = [
  'kindercare',
  'goddard school',
  'primrose',
  'la petite academy',
  'childtime',
  'tutor time',
  'the learning experience',
  'bright horizons',
  "children's lighthouse",
  'childrens lighthouse',
  'kiddie academy',
  'lightbridge',
  'big blue marble',
];

const HOME_PATTERNS = [
  /family child ?care/i,
  /family day ?care/i,
  /home day ?care/i,
  /day ?care home/i,
  /in[- ]home/i,
  /'s family/i,
];

/** Loose normalization used for dedupe: lowercase, drop noise words + punctuation. */
export function normalizeName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|inc|llc|ltd|co|corp|company)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isFranchise(name) {
  const n = normalizeName(name);
  return FRANCHISES.some((f) => n.includes(normalizeName(f)));
}

export function isHomeDaycare(name, tags = {}) {
  if (HOME_PATTERNS.some((re) => re.test(name || ''))) return true;
  if (tags.childcare === 'home') return true;
  if (['house', 'residential', 'detached', 'semidetached_house'].includes(tags.building)) {
    return true;
  }
  return false;
}
