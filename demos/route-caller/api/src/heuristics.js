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

/**
 * Public schools, elementary schools and Head Start programs — the caller does
 * not sell to them, so she wants them hidden.
 *
 * IMPORTANT, and different from the retail deny-list in pipeline.js: this rule
 * DOES match on names. That is deliberate and the two are not the same kind of
 * rule. The retail deny-list DELETES rows at ingest, so it may only act on
 * authoritative type data — a wrong call there loses a real facility silently
 * and permanently. This flag only HIDES a row behind a toggle the caller can
 * flip off, and the data stays in D1 either way. A wrong call here costs one
 * checkbox, so name evidence is an acceptable input. Do not copy this rule's
 * looseness back into the deny-list.
 *
 * Type and tag evidence is authoritative and flags on its own. Name evidence is
 * weaker, so a name that also carries a child-care word ("Little Scholars
 * Elementary Prep Daycare", "Grace Church Preschool") is left visible unless the
 * primaryType actually says school — a learning academy that happens to run
 * elementary grades may still buy.
 */
const SCHOOL_TYPES = new Set(['school', 'primary_school', 'secondary_school']);

const SCHOOL_NAME_PATTERNS = [
  /\bhead[\s-]?start\b/i,
  /\belementary\b/i,
  /\bmiddle school\b/i,
  /\bhigh school\b/i,
  /\bpublic school/i,
  /\bcity schools\b/i,
  /\bcounty schools\b/i,
  /\bboard of education\b/i,
];

const CHILDCARE_NAME_WORDS = [
  /\bpre-?schools?\b/i,
  /\bday\s?cares?\b/i,
  /\bchild\s?care\b/i,
  /\blearning cent(er|re)\b/i,
  /\bacademy\b/i,
];

export function isSchoolProgram(name, tags = {}, primaryType = null) {
  if (SCHOOL_TYPES.has(primaryType)) return true;
  if (tags?.amenity === 'school') return true;

  const candidate = name || '';
  if (!SCHOOL_NAME_PATTERNS.some((re) => re.test(candidate))) return false;
  // Name evidence only from here — ambiguous names stay visible.
  return !CHILDCARE_NAME_WORDS.some((re) => re.test(candidate));
}
