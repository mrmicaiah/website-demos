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
 * `is_school_program` — despite the column name, this now means
 * SCHOOL-AGE-OR-OLDER, not "public school". The boundary sharpened on
 * 2026-08-28 after the caller's second round of feedback.
 *
 * She sells playground equipment. Her line is developmental, not public/private:
 * **early-childhood places are prospects; anything serving school-age children
 * or older is not** — private prep schools and colleges included. That
 * supersedes the earlier private-school veto, which was protecting exactly the
 * prep schools and country day schools she now wants gone.
 *
 * The early-childhood guard is the ONLY veto, and it beats every other signal:
 * a name or Google type carrying preschool, pre-K, daycare, child care,
 * childcare, early learning, nursery, Montessori, `child_care_agency` or
 * `preschool` is never flagged. Real rows are why this has to outrank
 * everything: "The Connecticut College Children's Program", "Just 4 The Kids
 * Daycare College", "West Point Prep School" and "Applebrook Country Day
 * School" are all typed as child care or preschool by Google, and all of them
 * are her customers despite the college/prep/country-day words in their names.
 *
 * Head Start is the one deliberate exception that outranks the veto — see
 * below.
 *
 * Genuinely ambiguous rows are left UNFLAGGED and reported for her to rule on.
 * A wasted call beats a hidden prospect.
 */
// Specific enough to flag on their own.
const STRONG_SCHOOL_TYPES = new Set(['primary_school', 'secondary_school', 'university']);
// `school` is Google's catch-all and lands on both public elementary schools and
// church weekday programs, so it yields to an early-childhood-adjacent name.
const WEAK_SCHOOL_TYPE = 'school';

/** Early childhood: her market. Vetoes everything except Head Start. */
const EARLY_CHILDHOOD_TYPES = new Set(['child_care_agency', 'preschool']);

const EARLY_CHILDHOOD_NAMES = [
  /\bpre-?schools?\b/i,
  /\bpre-?k\b/i,
  /\bpre-?kindergarten\b/i,
  /\bday\s?cares?\b/i,
  /\bchild\s?care\b/i,
  /\bearly (learning|childhood|education)\b/i,
  /\bnursery\b/i,
  /\bmontessori\b/i,
  /\bwaldorf\b/i,
];

/**
 * Head Start is publicly funded and she asked for it hidden in her first round
 * of feedback. It is early childhood, so the veto would otherwise protect it —
 * many Head Starts are typed `preschool`. Her earlier instruction still stands,
 * so this is checked before the veto. Flagged here for whoever revisits it.
 */
const HEAD_START = /\bhead[\s-]?start\b/i;

const SCHOOL_AGE_NAMES = [
  // public school patterns, from her first round of feedback
  /\belementary\b/i,
  /\bmiddle school\b/i,
  /\bhigh school\b/i,
  /\bpublic school/i,
  /\bcity schools\b/i,
  /\bcounty schools\b/i,
  /\bboard of education\b/i,
  // higher education
  /\bcolleges?\b/i,
  /\buniversit(y|ies)\b/i,
  /\bseminary\b/i,
  /\badult (education|learning)\b/i,
  /\bcontinuing education\b/i,
  // private prep and the country-day shape, which the old private-marker veto
  // was protecting and which she now wants gone
  /\bpreparatory\b/i,
  /\bprep school\b/i,
  /\bcountry day\b/i,
  /\bcountry school\b/i,
];

/**
 * Weak counter-signals: not proof of early childhood, but enough doubt that a
 * bare `school` type alone should not hide the row. Taken from real rows —
 * "First Baptist Cleveland Weekday Ministry", "Fort Sanders Educational
 * Development center" and "Amy's Active Learning" are all typed `school` by
 * Google and all read like early-childhood programs.
 */
const EARLY_CHILDHOOD_ADJACENT = [
  /\blearning\b/i,
  /\bchildren'?s\b/i,
  /\bweekday\b/i,
  /\bministry\b/i,
  /\bdevelopment cent(er|re)\b/i,
];

export function isSchoolProgram(name, tags = {}, primaryType = null) {
  const candidate = name || '';

  if (HEAD_START.test(candidate)) return true;

  // The early-childhood veto. Nothing below this line can flag her market.
  if (EARLY_CHILDHOOD_TYPES.has(primaryType)) return false;
  if (EARLY_CHILDHOOD_NAMES.some((re) => re.test(candidate))) return false;

  if (STRONG_SCHOOL_TYPES.has(primaryType)) return true;
  if (tags?.amenity === 'school' || tags?.amenity === 'university') return true;
  if (SCHOOL_AGE_NAMES.some((re) => re.test(candidate))) return true;

  if (primaryType === WEAK_SCHOOL_TYPE) {
    // Ambiguous rows stay visible: a wasted call beats a hidden prospect.
    return !EARLY_CHILDHOOD_ADJACENT.some((re) => re.test(candidate));
  }
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
