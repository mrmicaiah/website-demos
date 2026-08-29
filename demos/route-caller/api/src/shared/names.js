// Name normalization and brand matching, shared by every pipeline in this Worker.
//
// Extracted from heuristics.js when area-caller arrived: both pipelines dedupe
// on the same normalized-name key and both classify franchises from an explicit
// brand list, so this is one implementation rather than two that drift.

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

/**
 * A matcher over an explicit list of brand names.
 *
 * Deliberately a LIST, never a pattern. "Roto-Rooter" is a national franchise
 * and "Rooter Man of Athens LLC" is somebody's independent shop; a `/rooter/`
 * pattern cannot tell them apart and would hide a real prospect. Both pipelines
 * pay for that discipline with a list that has to be expanded from real data,
 * which is the trade we want — see the hiding-is-never-deleting rule in
 * CONTEXT.md.
 */
export function makeListMatcher(brands) {
  const needles = brands.map(normalizeName).filter(Boolean);
  return (name) => {
    const n = normalizeName(name);
    return needles.some((brand) => n.includes(brand));
  };
}
