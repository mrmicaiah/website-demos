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
 * not sell playground equipment to public districts, so she wants them hidden.
 *
 * PRIVATE schools, academies, Montessoris and religious schools are PROSPECTS
 * and must never be flagged. That is her decision, made after seeing the first
 * cut hide forty rows on one route, most of them private. Public is the target;
 * everything else stays on the list.
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
 * Evidence, after narrowing:
 * - `primary_school` / `secondary_school` are specific enough to flag alone.
 * - A bare `school` type is NOT: on real routes it caught Montessoris, country
 *   day schools and parochial schools far more often than public ones. It flags
 *   only when a public-school name pattern agrees with it.
 * - Head Start and public-school name patterns flag on their own.
 * - Any private-school marker in the name vetoes all of the above. This is what
 *   keeps her prospects on the list, and it is why a public magnet named
 *   "Academy For Academics & Arts" now shows: a wasted call is cheaper than a
 *   hidden prospect.
 */
const STRONG_SCHOOL_TYPES = new Set(['primary_school', 'secondary_school']);
const WEAK_SCHOOL_TYPE = 'school';

const PUBLIC_NAME_PATTERNS = [
  /\bhead[\s-]?start\b/i,
  /\belementary\b/i,
  /\bmiddle school\b/i,
  /\bhigh school\b/i,
  /\bpublic school/i,
  /\bcity schools\b/i,
  /\bcounty schools\b/i,
  /\bboard of education\b/i,
];

/**
 * Names that mark a school as private, and therefore a prospect. Includes the
 * child-care words (a "Learning Center" or "Preschool" is her customer by
 * definition) plus the private and religious markers she called out.
 */
const PROSPECT_NAME_WORDS = [
  /\bpre-?schools?\b/i,
  /\bday\s?cares?\b/i,
  /\bchild\s?care\b/i,
  /\bchildren'?s\b/i,
  /\blearning cent(er|re)\b/i,
  /\bacadem(y|ies)\b/i,
  /\bmontessori\b/i,
  /\bwaldorf\b/i,
  /\bcountry (day )?school\b/i,
  /\bcountry day\b/i,
  /\bprep(aratory)?\b/i,
  /\bday school\b/i,
  /\bchristian\b/i,
  /\bcatholic\b/i,
  /\blutheran\b/i,
  /\bbaptist\b/i,
  /\bepiscopal\b/i,
  /\bmethodist\b/i,
  /\bpresbyterian\b/i,
  /\bhebrew\b/i,
  /\bjewish\b/i,
  /\bislamic\b/i,
  /\bmuslim\b/i,
  /\bparish\b/i,
  /\bsaints?\b/i,
  /\bholy\b/i,
];

export function isSchoolProgram(name, tags = {}, primaryType = null) {
  const candidate = name || '';

  // A private-school marker vetoes every other signal — prospects stay visible.
  if (PROSPECT_NAME_WORDS.some((re) => re.test(candidate))) return false;

  const publicName = PUBLIC_NAME_PATTERNS.some((re) => re.test(candidate));
  if (publicName) return true;
  if (STRONG_SCHOOL_TYPES.has(primaryType)) return true;
  if (tags?.amenity === 'school') return true;
  // A bare `school` type needs a public name to agree, and there isn't one here.
  if (primaryType === WEAK_SCHOOL_TYPE) return false;
  return false;
}

/**
 * Facility shapes that structurally would not have outdoor play equipment —
 * tutoring and test prep, music, dance, martial arts, swim. She sells playground
 * equipment, so these are poor prospects and she wants them hidden by default.
 *
 * Deliberately conservative, because the costs are asymmetric: a wrongly hidden
 * prospect is a lost sale, a wrongly shown one is a two-minute call. When in
 * doubt this returns false. In particular it NEVER fires on anything Google
 * types `child_care_agency` or `preschool` — those are her core market whatever
 * their name says — and it never fires on a name carrying a child-care word.
 *
 * Gymnastics centres, gyms and YMCAs are deliberately absent: they run children's
 * programs with outdoor space and are real prospects.
 */
const CORE_MARKET_TYPES = new Set(['child_care_agency', 'preschool']);

const NO_OUTDOOR_PLAY_TYPES = new Set([
  'performing_arts_theater',
  'dance_hall',
  'swimming_pool',
]);

const NO_OUTDOOR_PLAY_NAMES = [
  // tutoring / test prep
  /\bkumon\b/i,
  /\bmathnasium\b/i,
  /\bsylvan\b/i,
  /\btutor(ing|s)?\b/i,
  /\btest prep\b/i,
  /\bschool of mathematics\b/i,
  /\bmath school\b/i,
  // music
  /\bmusic (school|academy|lessons|studio)\b/i,
  /\bschool of music\b/i,
  // dance
  /\bdance (school|studio|academy|center|centre)\b/i,
  /\bschool of dance\b/i,
  /\bballet\b/i,
  // martial arts
  /\bmartial arts\b/i,
  /\bkarate\b/i,
  /\btae\s?kwon\s?do\b/i,
  /\bjiu[\s-]?jitsu\b/i,
  // swim
  /\bswim (school|academy|lessons)\b/i,
  /\bschool of swim/i,
];

export function isPlaygroundUnlikely(name, primaryType = null) {
  if (CORE_MARKET_TYPES.has(primaryType)) return false;

  const candidate = name || '';
  // A child-care word in the name is enough doubt to keep the row visible.
  if (
    [/\bpre-?schools?\b/i, /\bday\s?cares?\b/i, /\bchild\s?care\b/i].some((re) =>
      re.test(candidate)
    )
  ) {
    return false;
  }

  if (NO_OUTDOOR_PLAY_TYPES.has(primaryType)) return true;
  return NO_OUTDOOR_PLAY_NAMES.some((re) => re.test(candidate));
}
