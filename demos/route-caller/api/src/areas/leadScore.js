// THE LEAD SCORE. One formula, defined once, in three places that must agree:
// this file exports the SQL fragment the Worker orders by, the JS comparator
// the pipeline sorts by before insert, and the same comparator is mirrored in
// the frontend's sort. A test asserts SQL and JS produce the same order.
//
// Vertizin sells one $1,497/mo website package to established local service
// businesses. So the ideal first call, in order of how much each signal is
// worth:
//
//   1. NO WEBSITE — the headline. It is the whole pitch: the business is real,
//      it just has nothing to sell from. Sorted FIRST, not merely badged.
//   2. REVIEW COUNT, descending — the "established business" proxy. A shop with
//      400 Google reviews and no website has job volume and no way to convert
//      it. That is the best call on the list.
//   3. DISTANCE from the area centre, ascending — a tiebreak, and it keeps the
//      near work near.
//   4. NAME, so the order is fully deterministic.
//
// NULL review_count is NOT zero. It means the Enterprise field mask was
// unavailable on that run, so we do not know. It sorts to the BOTTOM of its
// website group rather than pretending to be a business with no reviews.

/** 0 when a row has no website, 1 when it has one. No-website sorts first. */
export const HAS_WEBSITE_SQL = `CASE WHEN website IS NULL OR TRIM(website) = '' THEN 0 ELSE 1 END`;

export const LEAD_SCORE_ORDER_BY = `
  ${HAS_WEBSITE_SQL} ASC,
  COALESCE(review_count, -1) DESC,
  COALESCE(distance_from_center_m, 0) ASC,
  name ASC`;

const hasWebsite = (f) => (f.website && String(f.website).trim() ? 1 : 0);
const reviews = (f) => (f.review_count == null ? -1 : Number(f.review_count));
const distance = (f) => (f.distance_from_center_m == null ? 0 : Number(f.distance_from_center_m));

export function byLeadScore(a, b) {
  return (
    hasWebsite(a) - hasWebsite(b) ||
    reviews(b) - reviews(a) ||
    distance(a) - distance(b) ||
    String(a.name || '').localeCompare(String(b.name || ''))
  );
}

/** The other sorts the caller can pick. Lead score is the default. */
export function byDistance(a, b) {
  return distance(a) - distance(b) || String(a.name || '').localeCompare(String(b.name || ''));
}

export function byMostReviewed(a, b) {
  return reviews(b) - reviews(a) || String(a.name || '').localeCompare(String(b.name || ''));
}

export function byName(a, b) {
  return String(a.name || '').localeCompare(String(b.name || ''));
}

export const SORTS = {
  lead: { label: 'Lead score', compare: byLeadScore },
  distance: { label: 'Distance', compare: byDistance },
  reviews: { label: 'Most reviewed', compare: byMostReviewed },
  name: { label: 'A–Z', compare: byName },
};
